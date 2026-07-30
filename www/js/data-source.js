/* ============================================================
   2. DATA SOURCE ABSTRACTION
   ------------------------------------------------------------
   `dataSource` (BybitDataSource, below) implements:
     fetchKlines(symbol, timeframe, limit) -> Promise<Candle[]>
     getInstrumentInfo(symbol)             -> Promise<InstrumentInfo>
     subscribeKlines(symbol, timeframe, handlers) -> stream handle with .close()
   No mock/simulated implementation exists anywhere in this app —
   removed entirely, including its exclusively-used support code
   (seeded RNG, fake per-symbol instrument table, simulated tick
   stream), per an explicit request that nothing not backed by a
   real Bybit response should ever be shown.
   ============================================================ */
const TIMEFRAMES = ['1m', '3m', '5m', '15m', '30m', '1h', '4h', '1d'];

/* ============================================================
   2b. BYBIT DATA SOURCE — real public market data (no auth needed)
   ------------------------------------------------------------
   No mock/fabricated fallback at all. A failed fetch falls back to
   the last successfully-cached REAL data for that symbol/timeframe
   (clearly flagged as stale via debug/console) if one exists; a
   symbol never successfully loaded before returns empty instead of
   inventing anything.
   ============================================================ */
const BYBIT_REST_BASE = 'https://api.bybit.com';
const BYBIT_KLINE_INTERVAL = { '1m': '1', '3m': '3', '5m': '5', '15m': '15', '30m': '30', '1h': '60', '4h': '240', '1d': 'D' };

class BybitDataSource {
  async fetchKlines(symbol, timeframe, limit = 300) {
    try {
      const interval = BYBIT_KLINE_INTERVAL[timeframe];
      const url = `${BYBIT_REST_BASE}/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval}&limit=${limit}`;
      const resp = await fetch(url);
      const json = await resp.json();
      if (json.retCode !== 0) throw new Error(json.retMsg || 'Bybit API error');
      // Bybit returns newest-first: [start, open, high, low, close, volume, turnover]
      const candles = json.result.list.map(k => ({
        time: Math.floor(Number(k[0]) / 1000), open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]),
      })).sort((a, b) => a.time - b.time);
      if (!candles.length) throw new Error('empty kline response');
      saveCachedKlines(symbol, timeframe, candles); // remember this real data for next time
      return candles;
    } catch (err) {
      const cached = loadCachedKlines(symbol, timeframe);
      if (cached && cached.length) {
        console.warn(`BybitDataSource.fetchKlines failed for ${symbol} ${timeframe}, showing last cached REAL data (stale):`, err.message);
        return cached;
      }
      console.warn(`BybitDataSource.fetchKlines failed for ${symbol} ${timeframe} and no cache exists — returning empty:`, err.message);
      return [];
    }
  }

  async getInstrumentInfo(symbol) {
    try {
      const url = `${BYBIT_REST_BASE}/v5/market/instruments-info?category=linear&symbol=${symbol}`;
      const resp = await fetch(url);
      const json = await resp.json();
      if (json.retCode !== 0 || !json.result.list.length) throw new Error(json.retMsg || 'symbol not found');
      const info = json.result.list[0];
      const parsed = {
        tickSize: Number(info.priceFilter.tickSize),
        qtyStep: Number(info.lotSizeFilter.qtyStep),
        minOrderQty: Number(info.lotSizeFilter.minOrderQty),
        maxLeverage: Number(info.leverageFilter.maxLeverage),
      };
      saveCachedInstrumentInfo(symbol, parsed);
      return parsed;
    } catch (err) {
      const cached = loadCachedInstrumentInfo(symbol);
      if (cached) {
        console.warn(`BybitDataSource.getInstrumentInfo failed for ${symbol}, using last cached REAL info (stale):`, err.message);
        return cached;
      }
      // Genuinely no real data available at all — this can't safely be
      // "blank" the way candles can (trade math needs *some* tick size to
      // function), so this is a bare, clearly-flagged minimal default, not
      // a fabricated instrument — the caller should treat it as untrusted.
      console.error(`BybitDataSource.getInstrumentInfo failed for ${symbol} with no cache available — trade math will be unreliable until a real fetch succeeds:`, err.message);
      return { tickSize: 0.01, qtyStep: 0.01, minOrderQty: 0.01, maxLeverage: 1 };
    }
  }

  // Bybit's real streaming path is a public WebSocket. See
  // BybitWebSocketStream below for the actual implementation — this just
  // delegates to it, matching the identical {onCandle, onStatus} handler
  // interface, so nothing above this layer changes.
  subscribeKlines(symbol, timeframe, handlers, seedCandle) {
    return new BybitWebSocketStream(symbol, timeframe, handlers, seedCandle);
  }
}

/* ============================================================
   2c. BYBIT WEBSOCKET STREAM — real live kline data
   ------------------------------------------------------------
   wss://stream.bybit.com/v5/public/linear, topic kline.{interval}.{symbol}.
   Bybit sends "confirm": false while a bar is still forming and "confirm":
   true once it closes — that maps directly to isNewBar.

   Ping/pong: Bybit's own reference client libraries default to ~10-20s
   ping intervals; general WebSocket practice recommends 20-30s. This uses
   a 20s ping / 10s pong-timeout, matching both.
   ============================================================ */
class BybitWebSocketStream {
  constructor(symbol, timeframe, handlers, seedCandle) {
    this.symbol = symbol;
    this.timeframe = timeframe;
    this.handlers = handlers;
    this._closed = false;
    this._ws = null;
    this._retryDelay = 1000;
    this._pingTimer = null;
    this._pongTimeout = null;
    // Bybit's WS `start` field is milliseconds; seedCandle.time (from REST)
    // is seconds, matching this app's internal convention — convert once
    // here so the very first WS message compares correctly and continues
    // the same last real bar rather than treating it as a new one.
    this._lastBarStart = seedCandle ? seedCandle.time * 1000 : null;
    this._connect();
  }

  _connect() {
    if (this._closed) return;
    this.handlers.onStatus('connecting');

    const wsInterval = BYBIT_KLINE_INTERVAL[this.timeframe];
    const topic = `kline.${wsInterval}.${this.symbol}`;

    try {
      this._ws = new WebSocket('wss://stream.bybit.com/v5/public/linear');
    } catch (err) {
      console.warn('BybitWebSocketStream: failed to construct WebSocket:', err);
      this._scheduleReconnect();
      return;
    }

    this._ws.onopen = () => {
      if (this._closed) return;
      this._retryDelay = 1000; // reset backoff on a successful connect
      this._ws.send(JSON.stringify({ op: 'subscribe', args: [topic] }));
      this._startHeartbeat();
    };

    this._ws.onmessage = (event) => {
      if (this._closed) return;
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }

      if (msg.op === 'pong' || msg.ret_msg === 'pong') {
        clearTimeout(this._pongTimeout);
        return;
      }
      if (msg.op === 'subscribe') {
        if (msg.success) this.handlers.onStatus('connected');
        else { console.warn('BybitWebSocketStream: subscribe failed:', msg); this.handlers.onStatus('disconnected'); }
        return;
      }
      if (msg.topic && msg.topic.startsWith('kline.') && Array.isArray(msg.data)) {
        for (const k of msg.data) {
          const barTime = Math.floor(Number(k.start) / 1000); // ms -> seconds
          const isNewBar = this._lastBarStart !== null && Number(k.start) !== this._lastBarStart;
          this._lastBarStart = Number(k.start);
          this.handlers.onCandle({
            time: barTime,
            open: Number(k.open), high: Number(k.high), low: Number(k.low), close: Number(k.close),
          }, isNewBar);
        }
      }
    };

    this._ws.onerror = () => {
      // onclose fires immediately after in virtually every browser/WebView
      // implementation — that single path handles the actual reconnect.
    };

    this._ws.onclose = () => {
      if (this._closed) return;
      this._stopHeartbeat();
      this.handlers.onStatus('disconnected');
      this._scheduleReconnect();
    };
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this._pingTimer = setInterval(() => {
      if (this._ws && this._ws.readyState === WebSocket.OPEN) {
        this._ws.send(JSON.stringify({ op: 'ping' }));
        this._pongTimeout = setTimeout(() => {
          console.warn('BybitWebSocketStream: no pong within 10s, forcing reconnect');
          if (this._ws) this._ws.close();
        }, 10000);
      }
    }, 20000);
  }
  _stopHeartbeat() {
    clearInterval(this._pingTimer);
    clearTimeout(this._pongTimeout);
  }

  _scheduleReconnect() {
    if (this._closed) return;
    setTimeout(() => {
      if (this._closed) return;
      this._retryDelay = Math.min(this._retryDelay * 2, 16000); // exponential backoff, capped
      this._connect();
    }, this._retryDelay);
  }

  close() {
    this._closed = true;
    this._stopHeartbeat();
    if (this._ws) { try { this._ws.close(); } catch (err) { /* already closing/closed */ } this._ws = null; }
  }
}

const dataSource = new BybitDataSource();
