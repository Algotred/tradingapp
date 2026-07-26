/* ============================================================
   2. DATA SOURCE ABSTRACTION
   ------------------------------------------------------------
   Every consumer (chart init, timeframe switching, future Bybit
   integration) talks to `dataSource` through this same interface:
     fetchKlines(symbol, timeframe, limit) -> Promise<Candle[]>
     getInstrumentInfo(symbol)             -> Promise<InstrumentInfo>
     subscribeKlines(symbol, timeframe, handlers) -> stream handle with .close()
   Phase 4 swaps MockDataSource for a BybitDataSource implementing
   the exact same three methods — nothing above this layer changes.
   ============================================================ */
const TIMEFRAMES = ['1m', '3m', '5m', '15m', '30m', '1h', '4h', '1d'];
const TF_SECONDS = { '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '1d': 86400 };

// deterministic seeded RNG (mulberry32) — so re-fetching the same symbol+timeframe
// combo produces the same-shaped candles within a session, like a real cached feed
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = (Math.imul(31, h) + s.charCodeAt(i)) | 0; }
  return h >>> 0;
}
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// mock per-symbol instrument metadata — shape matches what Bybit's real
// instrument-info endpoint returns, so Phase 4 is a drop-in data swap
const MOCK_INSTRUMENTS = {
  BTCUSDT: { tickSize: 0.1, qtyStep: 0.001, minOrderQty: 0.001, maxLeverage: 100, basePrice: 65000 },
  ETHUSDT: { tickSize: 0.01, qtyStep: 0.01, minOrderQty: 0.01, maxLeverage: 100, basePrice: 3400 },
  SOLUSDT: { tickSize: 0.001, qtyStep: 0.1, minOrderQty: 0.1, maxLeverage: 75, basePrice: 145 },
  DEFAULT: { tickSize: 0.01, qtyStep: 0.01, minOrderQty: 0.01, maxLeverage: 50, basePrice: 100 },
};

class MockDataSource {
  async fetchKlines(symbol, timeframe, limit = 300) {
    const info = MOCK_INSTRUMENTS[symbol] || MOCK_INSTRUMENTS.DEFAULT;
    const rand = mulberry32(hashStr(symbol + ':' + timeframe));
    const interval = TF_SECONDS[timeframe] || 86400;
    const data = [];
    let price = info.basePrice;
    let t = Math.floor(Date.now() / 1000 / interval) * interval - limit * interval;
    for (let i = 0; i < limit; i++) {
      const open = price;
      const volatility = price * 0.006;
      const close = Math.max(price * 0.01, open + (rand() - 0.5) * volatility * 2);
      const high = Math.max(open, close) + rand() * volatility;
      const low = Math.max(price * 0.005, Math.min(open, close) - rand() * volatility);
      data.push({ time: t, open, high, low, close });
      price = close;
      t += interval;
    }
    return data;
  }

  async getInstrumentInfo(symbol) {
    return MOCK_INSTRUMENTS[symbol] || MOCK_INSTRUMENTS.DEFAULT;
  }

  // handlers: { onCandle(candle, isNewBar), onStatus('connecting'|'connected'|'disconnected') }
  // seedCandle: the last real (non-whitespace) candle already loaded via
  // fetchKlines — the stream continues from exactly that bar instead of
  // independently guessing "now", which previously caused an off-by-one-bar
  // mismatch (the stream assumed the currently-forming bar already existed
  // in history, and stomped the last historical bar's time forward by one
  // full interval, colliding with the whitespace point right after it).
  subscribeKlines(symbol, timeframe, handlers, seedCandle) {
    return new ReconnectingStream(symbol, timeframe, handlers, seedCandle);
  }
}

// Simulates a live WS feed: ticks the current forming bar every ~1.2s, closes
// it and opens a new one every `timeframe` interval, and randomly drops the
// "connection" every so often to exercise real reconnect/backoff logic —
// the same handler shape a real Bybit WebSocket wrapper will need in Phase 4.
class ReconnectingStream {
  constructor(symbol, timeframe, handlers, seedCandle) {
    this.symbol = symbol;
    this.timeframe = timeframe;
    this.handlers = handlers;
    this._seed = seedCandle;
    this._closed = false;
    this._retryDelay = 1000;
    this._tickTimer = null;
    this._dropTimer = null;
    this._current = null;
    this._connect();
  }
  _connect() {
    if (this._closed) return;
    this.handlers.onStatus('connecting');
    const rand = mulberry32((Date.now() ^ hashStr(this.symbol)) >>> 0);
    setTimeout(() => {
      if (this._closed) return;
      this.handlers.onStatus('connected');
      this._retryDelay = 1000; // reset backoff on a successful connect
      const interval = TF_SECONDS[this.timeframe] || 86400;
      // continue from the real last historical bar (seed) if we have one and
      // it isn't already stale; only fall back to reconstructing from "now"
      // if we're reconnecting later with no seed on hand
      if (this._current === null && this._seed) {
        this._current = { ...this._seed };
      } else if (this._current === null) {
        const info = MOCK_INSTRUMENTS[this.symbol] || MOCK_INSTRUMENTS.DEFAULT;
        this._current = { time: Math.floor(Date.now() / 1000 / interval) * interval, open: info.basePrice, high: info.basePrice, low: info.basePrice, close: info.basePrice };
      }
      this._tickTimer = setInterval(() => this._tick(interval), 1200);
      // simulate an occasional dropped connection, 45-90s apart
      this._dropTimer = setTimeout(() => this._simulateDrop(), 45000 + rand() * 45000);
    }, 500 + rand() * 500);
  }
  _tick(interval) {
    if (this._closed || !this._current) return;
    const nowBar = Math.floor(Date.now() / 1000 / interval) * interval;
    const isNewBar = nowBar !== this._current.time;
    const rand = Math.random();
    const move = this._current.close * 0.0015 * (rand - 0.5) * 2;
    if (isNewBar) {
      this._current = { time: nowBar, open: this._current.close, high: this._current.close, low: this._current.close, close: this._current.close + move };
    } else {
      this._current.close = Math.max(0.0001, this._current.close + move);
      this._current.high = Math.max(this._current.high, this._current.close);
      this._current.low = Math.min(this._current.low, this._current.close);
    }
    this.handlers.onCandle({ ...this._current }, isNewBar);
  }
  _simulateDrop() {
    if (this._closed) return;
    clearInterval(this._tickTimer);
    this.handlers.onStatus('disconnected');
    setTimeout(() => {
      if (this._closed) return;
      this._retryDelay = Math.min(this._retryDelay * 2, 16000); // exponential backoff, capped
      this._connect();
    }, this._retryDelay);
  }
  close() {
    this._closed = true;
    clearInterval(this._tickTimer);
    clearTimeout(this._dropTimer);
  }
}

/* ============================================================
   2b. BYBIT DATA SOURCE — real public market data (no auth needed)
   ------------------------------------------------------------
   Implements the exact same 3-method interface as MockDataSource,
   so nothing above this layer needs to know which one is active.
   Falls back to mock data automatically (with a clear debug message)
   if a fetch fails — CORS, network, symbol not found, etc.
   ============================================================ */
const BYBIT_REST_BASE = 'https://api.bybit.com';
const BYBIT_KLINE_INTERVAL = { '1m': '1', '3m': '3', '5m': '5', '15m': '15', '30m': '30', '1h': '60', '4h': '240', '1d': 'D' };

class BybitDataSource {
  constructor() { this._mock = new MockDataSource(); }

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
      return candles;
    } catch (err) {
      console.warn('BybitDataSource.fetchKlines failed, falling back to mock:', err.message);
      return this._mock.fetchKlines(symbol, timeframe, limit);
    }
  }

  async getInstrumentInfo(symbol) {
    try {
      const url = `${BYBIT_REST_BASE}/v5/market/instruments-info?category=linear&symbol=${symbol}`;
      const resp = await fetch(url);
      const json = await resp.json();
      if (json.retCode !== 0 || !json.result.list.length) throw new Error(json.retMsg || 'symbol not found');
      const info = json.result.list[0];
      return {
        tickSize: Number(info.priceFilter.tickSize),
        qtyStep: Number(info.lotSizeFilter.qtyStep),
        minOrderQty: Number(info.lotSizeFilter.minOrderQty),
        maxLeverage: Number(info.leverageFilter.maxLeverage),
        basePrice: undefined, // only used by the mock's own kline generator
      };
    } catch (err) {
      console.warn('BybitDataSource.getInstrumentInfo failed, falling back to mock:', err.message);
      return this._mock.getInstrumentInfo(symbol);
    }
  }

  // Bybit's real streaming path is a public WebSocket
  // (wss://stream.bybit.com/v5/public/linear) — that's a larger, separate
  // piece of wiring (subscribe/ping-pong/resubscribe-on-symbol-change).
  // For now this falls through to the same simulated tick stream the mock
  // uses, layered on top of whatever REAL historical candles were loaded
  // above, so at minimum the chart's history and instrument data are real
  // even before the live WS layer is built out.
  subscribeKlines(symbol, timeframe, handlers, seedCandle) {
    return this._mock.subscribeKlines(symbol, timeframe, handlers, seedCandle);
  }
}

const USE_LIVE_MARKET_DATA = true; // public data only — no keys required, safe to default on
const dataSource = USE_LIVE_MARKET_DATA ? new BybitDataSource() : new MockDataSource();
