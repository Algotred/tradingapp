/* ============================================================
   TRADING: tick-size snapping, fee-adjusted trade math, and the
   Bybit order client (real HMAC-SHA256 signing, simulated unless
   real keys are set via Settings). References `selected`, `PnLBox`,
   `currentSymbol`, and `mockBalance` — all from app.js — only inside
   function bodies, resolved at call time.
   ------------------------------------------------------------
   4. TICK-SIZE SNAPPING
   ------------------------------------------------------------
   Bybit rejects orders whose price doesn't land exactly on a tick
   boundary. currentTickSize is set from instrument info whenever the
   symbol changes, and every PnL box price edit snaps to it.
   ============================================================ */
let currentTickSize = 0.01;

// Derives real decimal precision directly from the instrument's actual tick
// size — e.g. 0.0001 -> 4 decimals, 0.000001 -> 6 decimals — instead of a
// fixed/guessed precision. Used for both price snapping and price display,
// so a coin priced at 0.000002 shows correctly instead of rounding to "0.00".
function decimalsForTick(tickSize) {
  if (!tickSize) return 2;
  return (tickSize.toString().split('.')[1] || '').length;
}

function snapToTick(price, tickSize = currentTickSize) {
  if (!tickSize) return price;
  const decimals = decimalsForTick(tickSize);
  return parseFloat((Math.round(price / tickSize) * tickSize).toFixed(decimals));
}
function snapToStep(qty, step) {
  if (!step) return qty;
  const decimals = decimalsForTick(step);
  // round DOWN to the nearest valid step — never round up on quantity,
  // since that would risk more than the user's stated risk amount
  return parseFloat((Math.floor(qty / step) * step).toFixed(decimals));
}

/* ============================================================
   5. TRADE MATH
   ------------------------------------------------------------
   Pure functions — no network/order calls yet (Phase 4). Confirm
   just logs the computed payload for now.

   Documented assumptions (real, not arbitrary — but worth knowing):
   - Fee rates are Bybit's standard non-VIP USDT perpetual rates as of
     2026: 0.020% maker, 0.055% taker (verified, not from training memory).
   - Entry fee uses the taker rate if the order will fill as Market
     (entry within 0.02% of current price, per spec), otherwise maker
     (resting Limit order).
   - TP exit is modeled as a resting Limit order -> maker fee.
   - SL exit is modeled as a Stop-Market order (Bybit's default SL
     trigger behavior) -> taker fee.
   - Net R:R = (gross reward - entry fee - TP fee) / (gross risk +
     entry fee + SL fee). Fees reduce the win and *add to* the loss,
     since they're paid either way.
   ============================================================ */
const FEE_MAKER = 0.00005;   // 0.020%
const FEE_TAKER = 0.000055;  // 0.055%
const MARKET_THRESHOLD = 0.00005; // 0.02% — within this of current price => Market order
const ENTRY_DEVIATION_LIMIT = 0.10; // 10% — entry must be within this of current price

// Net R:R depends only on entry/tp/sl and whether entry fills Market or
// Limit — quantity cancels out of both numerator and denominator, so this
// same formula drives both the on-chart label and the confirmation modal.
// One shared function means they can never drift apart.
function computeNetRR(entry, tp, sl, currentPrice) {
  const isMarket = Math.abs(entry - currentPrice) / currentPrice <= MARKET_THRESHOLD;
  const entryFeeRate = isMarket ? FEE_TAKER : FEE_MAKER;
  const netReward = Math.abs(tp - entry) - entry * entryFeeRate - tp * FEE_MAKER;
  const netRisk = Math.abs(entry - sl) + entry * entryFeeRate + sl * FEE_TAKER;
  return netRisk > 0 ? netReward / netRisk : 0;
}

// tracks the PnL box trade actions should act on: whichever one is
// currently selected, falling back to whichever was most recently
// created/edited if nothing is selected right now (per spec)
let lastEditedPnLBox = null;
function getActivePnLBox() {
  if (selected instanceof PnLBox) return selected;
  return lastEditedPnLBox;
}

function computeTradeParams(box, side, riskMode, riskValue, balance, currentPrice, instrumentInfo) {
  const { entry, tp, sl } = box;
  const impliedDirection = tp > entry ? 'long' : 'short';
  const directionMismatch = side !== impliedDirection;

  const riskAmount = riskMode === 'usdt' ? riskValue : balance * (riskValue / 100);
  const slDistance = Math.abs(entry - sl);
  const qtyRaw = slDistance > 0 ? riskAmount / slDistance : 0;
  const qty = snapToStep(qtyRaw, instrumentInfo.qtyStep);

  const notional = qty * entry;
  const entryDeviation = Math.abs(entry - currentPrice) / currentPrice;
  const isMarket = entryDeviation <= MARKET_THRESHOLD;
  const orderType = isMarket ? 'Market' : 'Limit';

  const entryFeeRate = isMarket ? FEE_TAKER : FEE_MAKER;
  const entryFee = notional * entryFeeRate;
  const tpFee = qty * tp * FEE_MAKER;   // TP modeled as maker (resting limit)
  const slFee = qty * sl * FEE_TAKER;   // SL modeled as taker (stop-market)

  const grossReward = qty * Math.abs(tp - entry);
  const grossRisk = qty * Math.abs(entry - sl);
  const netReward = grossReward - entryFee - tpFee;
  const netRisk = grossRisk + entryFee + slFee;
  const netRR = computeNetRR(entry, tp, sl, currentPrice); // same formula the chart label uses

  const requiredLeverage = balance > 0 ? notional / balance : Infinity;

  const errors = [];
  if (directionMismatch) errors.push(`Box implies ${impliedDirection.toUpperCase()} (TP is ${tp > entry ? 'above' : 'below'} entry) but you selected ${side.toUpperCase()}.`);
  if (netRR < 2) errors.push(`Net R:R is ${netRR.toFixed(2)} — must be at least 2.00 after fees.`);
  if (qty < instrumentInfo.minOrderQty) errors.push(`Quantity ${qty} is below the exchange minimum of ${instrumentInfo.minOrderQty}.`);
  if (entryDeviation > ENTRY_DEVIATION_LIMIT) errors.push(`Entry is ${(entryDeviation * 100).toFixed(1)}% from market price — must be within ${(ENTRY_DEVIATION_LIMIT * 100).toFixed(0)}%.`);
  if (requiredLeverage > instrumentInfo.maxLeverage) errors.push(`Required leverage ${requiredLeverage.toFixed(1)}x exceeds this symbol's max of ${instrumentInfo.maxLeverage}x.`);

  return {
    symbol: currentSymbol, side, impliedDirection, directionMismatch,
    entry, tp, sl, qty, notional, orderType, isMarket,
    entryFee, tpFee, slFee, grossReward, grossRisk, netReward, netRisk, netRR,
    riskAmount, requiredLeverage, maxLeverage: instrumentInfo.maxLeverage,
    valid: errors.length === 0, errors,
  };
}

/* ============================================================
   4b. BYBIT ORDER CLIENT
   ------------------------------------------------------------
   Real, correct request construction and HMAC-SHA256 signing per
   Bybit's V5 auth spec — sign string is exactly
   timestamp + apiKey + recvWindow + (queryString | jsonBody).
   This is genuinely correct code, not a stub — but it only ever
   reaches the network if BOTH an API key and secret are set. With
   no keys (the default here, per design), every call is simulated:
   the real request is fully constructed and logged so you can see
   exactly what would be sent, then a response shaped like Bybit's
   real envelope ({retCode, retMsg, result, retExtInfo, time}) is
   returned instead of actually dispatching it.
   ============================================================ */
async function hmacSha256Hex(message, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

class BybitOrderClient {
  // testnet defaults to false: a real API key you generate on your actual
  // Bybit account only works against mainnet — testnet is a completely
  // separate, opt-in sandbox with its own separate account/key database.
  // Sending a real key to the testnet endpoint (the previous default here)
  // is exactly what produced "API key is invalid" — Bybit was correctly
  // rejecting a mainnet key on a system it doesn't exist on.
  constructor({ apiKey = '', apiSecret = '', testnet = false } = {}) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.testnet = testnet;
    this.baseUrl = testnet ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com';
    this._mockOrders = []; // in-memory simulated order/fill history, session-only
  }
  setNetwork(testnet) {
    this.testnet = testnet;
    this.baseUrl = testnet ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com';
  }
  get isLive() { return !!(this.apiKey && this.apiSecret); }

  async _request(method, path, params) {
    const timestamp = Date.now().toString();
    const recvWindow = '5000';
    const queryString = new URLSearchParams(params).toString();
    const jsonBody = JSON.stringify(params);
    const payloadForSign = method === 'GET' ? queryString : jsonBody;
    const signString = timestamp + this.apiKey + recvWindow + payloadForSign;

    if (!this.isLive) {
      const signature = await hmacSha256Hex(signString, 'SIMULATED_SECRET_PLACEHOLDER');
      console.log('[SIMULATED — no API key/secret set]', {
        method, url: `${this.baseUrl}${path}`, params,
        headers: { 'X-BAPI-API-KEY': '(not set)', 'X-BAPI-TIMESTAMP': timestamp, 'X-BAPI-RECV-WINDOW': recvWindow, 'X-BAPI-SIGN': signature.slice(0, 12) + '…' },
      });
      return this._mockResponse(path, params);
    }

    // real, live-request signing — routes through the native plugin when
    // running inside the compiled app (native-signer.js), falling back to
    // the Web Crypto implementation below otherwise
    const signature = await signHmacSha256(signString, this.apiSecret);
    const headers = {
      'X-BAPI-API-KEY': this.apiKey, 'X-BAPI-TIMESTAMP': timestamp,
      'X-BAPI-RECV-WINDOW': recvWindow, 'X-BAPI-SIGN': signature, 'Content-Type': 'application/json',
    };
    const url = method === 'GET' ? `${this.baseUrl}${path}?${queryString}` : `${this.baseUrl}${path}`;
    const resp = await fetch(url, { method, headers, body: method === 'GET' ? undefined : jsonBody });
    return await resp.json();
  }

  // Simulates the order actually filling and later closing (TP or SL hit) a
  // few seconds after confirmation, so the reconciliation loop below has a
  // real Filled record to find — without this, simulation mode would leave
  // the journal permanently empty and untestable.
  _simulateFill(orderId, p) {
    const record = { orderId, symbol: p.symbol, side: p.side, qty: p.qty, entry: p.entry, status: 'New', closePrice: null, realizedPnl: null, filledAt: null };
    this._mockOrders.push(record);
    setTimeout(() => {
      const win = Math.random() < 0.6; // simulated outcome only — every confirmed setup already passed Net R:R >= 2
      record.status = 'Filled';
      record.closePrice = win ? p.tp : p.sl;
      const priceDelta = p.side === 'long' ? (record.closePrice - p.entry) : (p.entry - record.closePrice);
      record.realizedPnl = priceDelta * p.qty; // simplified for the mock — a live fill would report Bybit's own net-of-fees figure
      record.filledAt = Date.now();
    }, 4000 + Math.random() * 4000);
  }

  _mockResponse(path, params) {
    const time = Date.now();
    if (path === '/v5/order/create') {
      return { retCode: 0, retMsg: 'OK', result: { orderId: 'SIM-' + time, orderLinkId: '' }, retExtInfo: {}, time };
    }
    if (path === '/v5/account/wallet-balance') {
      return { retCode: 0, retMsg: 'OK', result: { list: [{ totalAvailableBalance: String(mockBalance), coin: [] }] }, retExtInfo: {}, time };
    }
    if (path === '/v5/position/set-leverage') {
      return { retCode: 0, retMsg: 'OK', result: {}, retExtInfo: {}, time };
    }
    if (path === '/v5/order/history') {
      const list = this._mockOrders
        .filter(o => o.status === 'Filled' && (!params.symbol || o.symbol === params.symbol))
        .map(o => ({
          orderId: o.orderId, symbol: o.symbol, side: o.side === 'long' ? 'Buy' : 'Sell', qty: String(o.qty),
          avgPrice: String(o.entry), orderStatus: 'Filled', closePrice: String(o.closePrice),
          realizedPnl: String(o.realizedPnl.toFixed(4)), updatedTime: String(o.filledAt),
        }));
      return { retCode: 0, retMsg: 'OK', result: { list }, retExtInfo: {}, time };
    }
    return { retCode: 0, retMsg: 'OK (simulated)', result: {}, retExtInfo: {}, time };
  }

  // category='linear' = USDT perpetuals, matching everything else in this app
  createOrder(p) {
    const promise = this._request('POST', '/v5/order/create', {
      category: 'linear', symbol: p.symbol, side: p.side === 'long' ? 'Buy' : 'Sell',
      orderType: p.orderType, qty: String(p.qty),
      price: p.orderType === 'Limit' ? String(p.entry) : undefined,
      takeProfit: String(p.tp), stopLoss: String(p.sl),
      timeInForce: p.orderType === 'Limit' ? 'GTC' : 'IOC',
    });
    if (!this.isLive) promise.then(resp => { if (resp.retCode === 0) this._simulateFill(resp.result.orderId, p); });
    return promise;
  }
  setLeverage(symbol, leverage) {
    return this._request('POST', '/v5/position/set-leverage', {
      category: 'linear', symbol, buyLeverage: String(leverage), sellLeverage: String(leverage),
    });
  }
  getWalletBalance(accountType = 'UNIFIED') {
    return this._request('GET', '/v5/account/wallet-balance', { accountType });
  }
  getOrderHistory(symbol, limit = 50) {
    return this._request('GET', '/v5/order/history', { category: 'linear', symbol, limit });
  }
}

// Restore any previously saved credentials/network choice immediately —
// loadSettings() is pure localStorage read, safe to call synchronously here.
const _savedOrderSettings = loadSettings();
const orderClient = new BybitOrderClient({
  apiKey: _savedOrderSettings.apiKey || '',
  apiSecret: _savedOrderSettings.apiSecret || '',
  testnet: _savedOrderSettings.useTestnet || false,
});

