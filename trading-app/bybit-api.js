// bybit-api.js
// Talks to Bybit's real V5 REST API. Public endpoints (klines/ticker) need no auth.
// Signed endpoints (balance/order) get their signature from the native BybitSigner
// plugin — the secret itself never exists in this file or anywhere in JS.

const BYBIT_BASE = "https://api.bybit.com";
const RECV_WINDOW = "10000"; // a little extra slack on top of the server-time sync below

// Device clocks drift — Bybit rejects any signed request whose timestamp is off from its
// server clock by more than recv_window. Sync once and apply the offset to every signed call.
let serverTimeOffsetMs = 0;
async function syncServerTime() {
  try {
    const res = await fetch(`${BYBIT_BASE}/v5/market/time`);
    const data = await res.json();
    const serverMs = Number(data.result?.timeNano) / 1e6 || Number(data.result?.timeSecond) * 1000;
    if (serverMs) serverTimeOffsetMs = serverMs - Date.now();
  } catch (err) {
    console.warn("Could not sync Bybit server time, using device clock as-is:", err.message);
  }
}
syncServerTime();
// re-sync occasionally in case the device clock drifts further during a long session
setInterval(syncServerTime, 10 * 60 * 1000);

// Capacitor exposes registered native plugins on window.Capacitor.Plugins
const BybitSigner = window.Capacitor?.Plugins?.BybitSigner;

const bybitApi = {
  hasNativeBridge: !!BybitSigner,

  async hasCredentials() {
    if (!BybitSigner) return false;
    const r = await BybitSigner.hasCredentials();
    return r.hasCredentials;
  },

  async saveCredentials(apiKey, apiSecret) {
    if (!BybitSigner) throw new Error("Native bridge not available (are you running in the wrapped app?)");
    return BybitSigner.saveCredentials({ apiKey, apiSecret });
  },

  async clearCredentials() {
    if (!BybitSigner) return;
    return BybitSigner.clearCredentials();
  },

  // ---------- public: no signing needed ----------
  async getKlines(symbol, interval, limit = 90, endTime = null) {
    let url = `${BYBIT_BASE}/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval}&limit=${limit}`;
    if (endTime) url += `&end=${endTime}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.retCode !== 0) throw new Error(data.retMsg || "Failed to fetch klines");
    // Bybit returns newest-first; each row: [start, open, high, low, close, volume, turnover]
    return data.result.list
      .slice()
      .reverse()
      .map((row) => ({
        time: Number(row[0]),
        open: Number(row[1]),
        high: Number(row[2]),
        low: Number(row[3]),
        close: Number(row[4]),
      }));
  },

  async getTicker(symbol) {
    const url = `${BYBIT_BASE}/v5/market/tickers?category=linear&symbol=${symbol}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.retCode !== 0) throw new Error(data.retMsg || "Failed to fetch ticker");
    return data.result.list[0];
  },

  // instrument precision rules — qty MUST be an exact multiple of qtyStep or Bybit rejects the
  // order outright ("Qty invalid"), independent of balance/leverage/margin.
  _instrumentCache: {},
  async getInstrumentInfo(symbol) {
    if (this._instrumentCache[symbol]) return this._instrumentCache[symbol];
    const url = `${BYBIT_BASE}/v5/market/instruments-info?category=linear&symbol=${symbol}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.retCode !== 0 || !data.result?.list?.length) throw new Error(data.retMsg || "Symbol not found");
    const info = data.result.list[0];
    const parsed = {
      qtyStep: parseFloat(info.lotSizeFilter.qtyStep),
      minOrderQty: parseFloat(info.lotSizeFilter.minOrderQty),
      tickSize: parseFloat(info.priceFilter.tickSize),
    };
    this._instrumentCache[symbol] = parsed;
    return parsed;
  },

  // ---------- signed: needs the native bridge ----------
  async _signedHeaders(payload) {
    const timestamp = Math.round(Date.now() + serverTimeOffsetMs).toString();
    const { apiKey } = await BybitSigner.getApiKey();
    const { signature } = await BybitSigner.sign({ timestamp, recvWindow: RECV_WINDOW, payload });
    return {
      "X-BAPI-API-KEY": apiKey,
      "X-BAPI-TIMESTAMP": timestamp,
      "X-BAPI-RECV-WINDOW": RECV_WINDOW,
      "X-BAPI-SIGN": signature,
      "Content-Type": "application/json",
    };
  },

  async getWalletBalance(accountType = "UNIFIED") {
    if (!BybitSigner) throw new Error("Native bridge not available");
    const query = `accountType=${accountType}`;
    const headers = await this._signedHeaders(query);
    const res = await fetch(`${BYBIT_BASE}/v5/account/wallet-balance?${query}`, { headers });
    const data = await res.json();
    if (data.retCode !== 0) throw new Error(data.retMsg || "Failed to fetch balance");
    return data.result;
  },

  async createOrder(order) {
    // order: { symbol, side: 'Buy'|'Sell', orderType: 'Market'|'Limit', qty, price?, takeProfit, stopLoss }
    if (!BybitSigner) throw new Error("Native bridge not available");
    const body = {
      category: "linear",
      symbol: order.symbol,
      side: order.side,
      orderType: order.orderType,
      qty: String(order.qty),
      takeProfit: String(order.takeProfit),
      stopLoss: String(order.stopLoss),
      ...(order.orderType === "Limit" ? { price: String(order.price) } : {}),
    };
    const payload = JSON.stringify(body);
    const headers = await this._signedHeaders(payload);
    const res = await fetch(`${BYBIT_BASE}/v5/order/create`, { method: "POST", headers, body: payload });
    const data = await res.json();
    if (data.retCode !== 0) throw new Error(data.retMsg || "Order failed");
    return data.result;
  },
};

window.bybitApi = bybitApi;
