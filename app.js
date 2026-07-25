(async function main() {
await window.__chartsReady;

// ===================== constants =====================
const THRESHOLD_PCT = 0.1;
const MIN_RR = 2;
const DEFAULT_SL_DISTANCE_PCT = 0.5;
const TIMEFRAMES = ['1m', '3m', '5m', '15m', '30m', '1h', '4h', '1d'];
const TF_SECONDS = { '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '1d': 86400 };
const TF_TO_BYBIT = { '1m': '1', '3m': '3', '5m': '5', '15m': '15', '30m': '30', '1h': '60', '4h': '240', '1d': 'D' };
const GREEN = '#1ED9A5', RED = '#F0455C', BLUE = '#3B82F6';
const HANDLE_R = 5, HIT_TOL = 14;
const FUTURE_WHITESPACE_BARS = 40;
const WS_BACKOFF_START = 1000, WS_BACKOFF_MAX = 30000;

// ===================== coordinate helpers =====================
let barIntervalSeconds = 900;
function computeBarInterval(data) {
  const real = data.filter((d) => d.open !== undefined);
  if (real.length >= 2) barIntervalSeconds = real[real.length - 1].time - real[real.length - 2].time;
}
function timeToX(t) { return chart.timeScale().timeToCoordinate(t); }
function xToTime(x) {
  const t = chart.timeScale().coordinateToTime(x);
  if (t !== null) return t;
  const logical = chart.timeScale().coordinateToLogical(x);
  if (logical === null) return null;
  const data = series.data();
  if (!data.length) return null;
  const lastLogical = data.length - 1;
  const lastTime = data[lastLogical].time;
  return Math.round(lastTime + (logical - lastLogical) * barIntervalSeconds);
}
function priceToY(p) { return series.priceToCoordinate(p); }
function yToPrice(y) { return series.coordinateToPrice(y); }
function addPixels(xRef, pixels) { return xToTime(xRef + pixels); }
function bitX(scope, mediaX) { return Math.round(mediaX * scope.horizontalPixelRatio); }
function bitY(scope, mediaY) { return Math.round(mediaY * scope.verticalPixelRatio); }

function appendFutureWhitespace(data, n) {
  if (data.length < 2) return data;
  const interval = data[data.length - 1].time - data[data.length - 2].time;
  let t = data[data.length - 1].time;
  const extended = data.slice();
  for (let i = 0; i < n; i++) { t += interval; extended.push({ time: t }); }
  return extended;
}

// ===================== formatting =====================
function formatPrice(price) {
  if (price == null || isNaN(price)) return '--';
  if (price === 0) return '0';
  const abs = Math.abs(price);
  if (abs >= 10000) return price.toFixed(1);
  const magnitude = Math.floor(Math.log10(abs));
  const sigFigs = abs < 0.001 ? 4 : 5;
  const decimals = Math.max(0, sigFigs - 1 - magnitude);
  return price.toFixed(decimals);
}
function fmt(n) { return formatPrice(n); }
function qtyDecimals() {
  return currentInstrument?.qtyStep ? (currentInstrument.qtyStep.toString().split('.')[1] || '').length : 5;
}
function roundToStep(value, step) {
  if (!step) return value;
  const rounded = Math.floor(value / step) * step;
  const decimals = (step.toString().split('.')[1] || '').length;
  return parseFloat(rounded.toFixed(decimals));
}
let currentTickSize = 0.01;
function snapToTick(price, tickSize = currentTickSize) {
  if (!tickSize) return price;
  const decimals = (tickSize.toString().split('.')[1] || '').length;
  return parseFloat((Math.round(price / tickSize) * tickSize).toFixed(decimals));
}

// ===================== data source: real Bybit via bybit-api.js, mock fallback =====================
function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0; return h >>> 0; }
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function basePriceFor(symbol) {
  if (symbol.startsWith('BTC')) return 61250;
  if (symbol.startsWith('ETH')) return 3380;
  if (symbol.startsWith('LTC')) return 46.9;
  if (symbol.startsWith('SOL')) return 152;
  return 25 + (symbol.charCodeAt(0) % 40);
}

class MockDataSource {
  async fetchKlines(symbol, timeframe, limit = 300) {
    const basePrice = basePriceFor(symbol);
    const rand = mulberry32(hashStr(symbol + ':' + timeframe));
    const interval = TF_SECONDS[timeframe] || 900;
    const data = [];
    let price = basePrice;
    let t = Math.floor(Date.now() / 1000 / interval) * interval - limit * interval;
    for (let i = 0; i < limit; i++) {
      const open = price;
      const vol = price * 0.006;
      const close = Math.max(price * 0.01, open + (rand() - 0.5) * vol * 2);
      const high = Math.max(open, close) + rand() * vol;
      const low = Math.max(price * 0.005, Math.min(open, close) - rand() * vol);
      data.push({ time: t, open, high, low, close });
      price = close; t += interval;
    }
    return data;
  }
  async getInstrumentInfo(symbol) {
    return { tickSize: 0.01, qtyStep: 0.01, minOrderQty: 0.01, maxLeverage: 50 };
  }
  subscribeKlines(symbol, timeframe, handlers, seedCandle) {
    return new MockStream(symbol, timeframe, handlers, seedCandle);
  }
}
class MockStream {
  constructor(symbol, timeframe, handlers, seedCandle) {
    this.handlers = handlers; this.timeframe = timeframe; this._closed = false;
    this._current = seedCandle ? { ...seedCandle } : null;
    this.handlers.onStatus('connecting');
    setTimeout(() => {
      if (this._closed) return;
      this.handlers.onStatus('connected');
      const interval = TF_SECONDS[timeframe] || 900;
      this._timer = setInterval(() => this._tick(interval), 1200);
    }, 400);
  }
  _tick(interval) {
    if (this._closed || !this._current) return;
    const nowBar = Math.floor(Date.now() / 1000 / interval) * interval;
    const isNewBar = nowBar !== this._current.time;
    const move = this._current.close * 0.0015 * (Math.random() - 0.5) * 2;
    if (isNewBar) this._current = { time: nowBar, open: this._current.close, high: this._current.close, low: this._current.close, close: this._current.close + move };
    else { this._current.close = Math.max(0.0001, this._current.close + move); this._current.high = Math.max(this._current.high, this._current.close); this._current.low = Math.min(this._current.low, this._current.close); }
    this.handlers.onCandle({ ...this._current }, isNewBar);
  }
  close() { this._closed = true; clearInterval(this._timer); }
}

class BybitDataSource {
  async fetchKlines(symbol, timeframe, limit = 300) {
    const raw = await window.bybitApi.getKlines(symbol, TF_TO_BYBIT[timeframe] || '15', limit);
    return raw.map((c) => ({ time: Math.floor(c.time / 1000), open: c.open, high: c.high, low: c.low, close: c.close }));
  }
  async getInstrumentInfo(symbol) { return window.bybitApi.getInstrumentInfo(symbol); }
  subscribeKlines(symbol, timeframe, handlers, seedCandle) {
    return new BybitStream(symbol, timeframe, handlers);
  }
}
// Persistent-feeling stream: one socket, resubscribes on symbol/timeframe change (handled by
// caller closing+reopening), auto-reconnects with exponential backoff on drop.
class BybitStream {
  constructor(symbol, timeframe, handlers) {
    this.symbol = symbol; this.timeframe = timeframe; this.handlers = handlers;
    this.topic = `kline.${TF_TO_BYBIT[timeframe] || '15'}.${symbol}`;
    this._closed = false;
    this._backoff = WS_BACKOFF_START;
    this._connect();
  }
  _connect() {
    if (this._closed) return;
    this.handlers.onStatus('connecting');
    const ws = new WebSocket('wss://stream.bybit.com/v5/public/linear');
    this.ws = ws;
    ws.onopen = () => {
      this._backoff = WS_BACKOFF_START;
      this.handlers.onStatus('connected');
      ws.send(JSON.stringify({ op: 'subscribe', args: [this.topic] }));
    };
    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        if (msg.topic !== this.topic || !msg.data?.length) return;
        const k = msg.data[0];
        const candle = { time: Math.floor(Number(k.start) / 1000), open: +k.open, high: +k.high, low: +k.low, close: +k.close };
        this.handlers.onCandle(candle, !!k.confirm);
      } catch (e) { /* ignore malformed frames */ }
    };
    ws.onclose = () => this._scheduleReconnect();
    ws.onerror = () => { try { ws.close(); } catch (e) {} };
  }
  _scheduleReconnect() {
    if (this._closed) return;
    this.handlers.onStatus('disconnected');
    setTimeout(() => { if (!this._closed) this._connect(); }, this._backoff);
    this._backoff = Math.min(WS_BACKOFF_MAX, this._backoff * 2);
  }
  close() { this._closed = true; try { this.ws?.close(); } catch (e) {} }
}

const dataSource = window.bybitApi ? new BybitDataSource() : new MockDataSource();

// ===================== persistence =====================
const STORAGE_PREFIX = 'pnltools:';
function serializePrimitive(p) {
  if (p instanceof TrendLine) return { type: 'trendline', p1: p.p1, p2: p.p2 };
  if (p instanceof BoxDrawing) return { type: 'box', p1: p.p1, p2: p.p2 };
  if (p instanceof PnLBox) return { type: 'pnl', t1: p.t1, t2: p.t2, entry: p.entry, tp: p.tp, sl: p.sl };
  return null;
}
function deserializePrimitive(d) {
  if (d.type === 'trendline') return new TrendLine(d.p1, d.p2);
  if (d.type === 'box') return new BoxDrawing(d.p1, d.p2);
  if (d.type === 'pnl') return new PnLBox(d.t1, d.t2, d.entry, d.tp, d.sl);
  return null;
}
function saveDrawings(symbol) {
  try { localStorage.setItem(STORAGE_PREFIX + 'drawings:' + symbol, JSON.stringify(primitives.map(serializePrimitive).filter(Boolean))); }
  catch (err) { console.warn('saveDrawings failed', err); }
}
function loadDrawingsFor(symbol) {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + 'drawings:' + symbol);
    return raw ? JSON.parse(raw).map(deserializePrimitive).filter(Boolean) : [];
  } catch (err) { return []; }
}
function saveJournal() { try { localStorage.setItem('journal', JSON.stringify(journal)); } catch (e) {} }
function loadJournal() { try { const raw = localStorage.getItem('journal'); journal = raw ? JSON.parse(raw) : []; } catch (e) { journal = []; } }

// ===================== DOM refs =====================
const $ = (id) => document.getElementById(id);
const chartArea = $('chartArea');
const debugLine = $('debugLine');
function setDebug(text, isError) { debugLine.textContent = text; debugLine.style.color = isError ? '#F0455C' : '#6B7280'; }

// ===================== chart setup =====================
let chart, series;
try {
  chart = LightweightCharts.createChart(chartArea, {
    layout: { background: { type: 'solid', color: '#0A0C0F' }, textColor: '#E7E9EC' },
    grid: { vertLines: { color: '#1A1D24' }, horzLines: { color: '#1A1D24' } },
    rightPriceScale: { borderColor: '#22262D', autoScale: true },
    timeScale: { borderColor: '#22262D', timeVisible: true, rightOffset: 20 },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    handleScale: { axisPressedMouseMove: { time: true, price: false }, pinch: true, mouseWheel: true, axisDoubleClickReset: true },
    width: chartArea.clientWidth, height: chartArea.clientHeight || 400,
  });
  chart.resize(chartArea.clientWidth || 320, chartArea.clientHeight || 400);
  series = chart.addCandlestickSeries({ upColor: GREEN, downColor: RED, borderVisible: false, wickUpColor: GREEN, wickDownColor: RED });
} catch (err) {
  setDebug('Chart init failed: ' + err.message, true);
  throw err;
}
new ResizeObserver((entries) => { const { width, height } = entries[0].contentRect; chart.resize(width, height); }).observe(chartArea);

// ===================== geometry =====================
function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

// ===================== primitives =====================
class DraggablePrimitive {
  constructor() { this.selected = false; this._requestUpdate = null; this._paneView = { renderer: () => ({ draw: (t) => this.draw(t) }) }; }
  attached(param) { this._requestUpdate = param.requestUpdate; }
  detached() {}
  updateAllViews() {}
  paneViews() { return [this._paneView]; }
  refresh() { if (this._requestUpdate) this._requestUpdate(); }
  draw() {}
  hitTest() { return null; }
  beginDrag() {}
  drag() {}
  endDrag() {}
}

class TrendLine extends DraggablePrimitive {
  constructor(p1, p2, color = '#F5A623') { super(); this.p1 = p1; this.p2 = p2; this.color = color; this._dragOrigin = null; }
  draw(target) {
    const x1 = timeToX(this.p1.time), y1 = priceToY(this.p1.price), x2 = timeToX(this.p2.time), y2 = priceToY(this.p2.price);
    if (x1 === null || y1 === null || x2 === null || y2 === null) return;
    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context;
      ctx.save();
      ctx.strokeStyle = this.color; ctx.lineWidth = 2 * scope.horizontalPixelRatio;
      ctx.beginPath(); ctx.moveTo(bitX(scope, x1), bitY(scope, y1)); ctx.lineTo(bitX(scope, x2), bitY(scope, y2)); ctx.stroke();
      if (this.selected) {
        [[x1, y1], [x2, y2]].forEach(([x, y]) => {
          ctx.beginPath(); ctx.arc(bitX(scope, x), bitY(scope, y), HANDLE_R * scope.horizontalPixelRatio, 0, Math.PI * 2);
          ctx.fillStyle = '#0A0C0F'; ctx.fill(); ctx.lineWidth = 2 * scope.horizontalPixelRatio; ctx.strokeStyle = this.color; ctx.stroke();
        });
      }
      ctx.restore();
    });
  }
  hitTest(x, y) {
    const x1 = timeToX(this.p1.time), y1 = priceToY(this.p1.price), x2 = timeToX(this.p2.time), y2 = priceToY(this.p2.price);
    if (x1 === null || y1 === null || x2 === null || y2 === null) return null;
    if (Math.hypot(x - x1, y - y1) <= HANDLE_R + HIT_TOL) return 'p1';
    if (Math.hypot(x - x2, y - y2) <= HANDLE_R + HIT_TOL) return 'p2';
    if (distToSegment(x, y, x1, y1, x2, y2) <= HIT_TOL) return 'body';
    return null;
  }
  beginDrag(handle, x, y) {
    if (handle === 'body') this._dragOrigin = { startX: x, startY: y, p1x: timeToX(this.p1.time), p1y: priceToY(this.p1.price), p2x: timeToX(this.p2.time), p2y: priceToY(this.p2.price) };
  }
  drag(handle, x, y) {
    if (handle === 'p1') this.p1 = { time: xToTime(x) ?? this.p1.time, price: yToPrice(y) ?? this.p1.price };
    else if (handle === 'p2') this.p2 = { time: xToTime(x) ?? this.p2.time, price: yToPrice(y) ?? this.p2.price };
    else if (handle === 'body' && this._dragOrigin) {
      const o = this._dragOrigin, dx = x - o.startX, dy = y - o.startY;
      const t1 = xToTime(o.p1x + dx), pr1 = yToPrice(o.p1y + dy), t2 = xToTime(o.p2x + dx), pr2 = yToPrice(o.p2y + dy);
      if (t1 !== null && pr1 !== null) this.p1 = { time: t1, price: pr1 };
      if (t2 !== null && pr2 !== null) this.p2 = { time: t2, price: pr2 };
    }
    this.refresh();
  }
  endDrag() { this._dragOrigin = null; }
}

class BoxDrawing extends DraggablePrimitive {
  constructor(p1, p2, color = '#3B82F6') { super(); this.p1 = p1; this.p2 = p2; this.color = color; this._dragOrigin = null; }
  draw(target) {
    const x1 = timeToX(this.p1.time), y1 = priceToY(this.p1.price), x2 = timeToX(this.p2.time), y2 = priceToY(this.p2.price);
    if (x1 === null || y1 === null || x2 === null || y2 === null) return;
    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context;
      const bx1 = bitX(scope, Math.min(x1, x2)), bx2 = bitX(scope, Math.max(x1, x2));
      const by1 = bitY(scope, Math.min(y1, y2)), by2 = bitY(scope, Math.max(y1, y2));
      ctx.save();
      ctx.fillStyle = this.color + '2A'; ctx.fillRect(bx1, by1, bx2 - bx1, by2 - by1);
      ctx.strokeStyle = this.color; ctx.lineWidth = 1.5 * scope.horizontalPixelRatio; ctx.strokeRect(bx1, by1, bx2 - bx1, by2 - by1);
      if (this.selected) {
        [[x1, y1], [x1, y2], [x2, y1], [x2, y2]].forEach(([x, y]) => {
          ctx.beginPath(); ctx.arc(bitX(scope, x), bitY(scope, y), HANDLE_R * scope.horizontalPixelRatio, 0, Math.PI * 2);
          ctx.fillStyle = '#0A0C0F'; ctx.fill(); ctx.strokeStyle = this.color; ctx.lineWidth = 2 * scope.horizontalPixelRatio; ctx.stroke();
        });
      }
      ctx.restore();
    });
  }
  hitTest(x, y) {
    const x1 = timeToX(this.p1.time), y1 = priceToY(this.p1.price), x2 = timeToX(this.p2.time), y2 = priceToY(this.p2.price);
    if (x1 === null || y1 === null || x2 === null || y2 === null) return null;
    const minX = Math.min(x1, x2), maxX = Math.max(x1, x2), minY = Math.min(y1, y2), maxY = Math.max(y1, y2);
    if (Math.hypot(x - x1, y - y1) <= HANDLE_R + HIT_TOL) return 'p1';
    if (Math.hypot(x - x2, y - y2) <= HANDLE_R + HIT_TOL) return 'p2';
    if (Math.hypot(x - x1, y - y2) <= HANDLE_R + HIT_TOL) return 'p1y2';
    if (Math.hypot(x - x2, y - y1) <= HANDLE_R + HIT_TOL) return 'p2y1';
    if (x >= minX && x <= maxX && y >= minY && y <= maxY) return 'body';
    return null;
  }
  beginDrag(handle, x, y) {
    if (handle === 'body') this._dragOrigin = { startX: x, startY: y, p1x: timeToX(this.p1.time), p1y: priceToY(this.p1.price), p2x: timeToX(this.p2.time), p2y: priceToY(this.p2.price) };
  }
  drag(handle, x, y) {
    if (handle === 'p1') this.p1 = { time: xToTime(x) ?? this.p1.time, price: yToPrice(y) ?? this.p1.price };
    else if (handle === 'p2') this.p2 = { time: xToTime(x) ?? this.p2.time, price: yToPrice(y) ?? this.p2.price };
    else if (handle === 'p1y2') { const t = xToTime(x); if (t !== null) this.p1 = { ...this.p1, time: t }; const pr = yToPrice(y); if (pr !== null) this.p2 = { ...this.p2, price: pr }; }
    else if (handle === 'p2y1') { const t = xToTime(x); if (t !== null) this.p2 = { ...this.p2, time: t }; const pr = yToPrice(y); if (pr !== null) this.p1 = { ...this.p1, price: pr }; }
    else if (handle === 'body' && this._dragOrigin) {
      const o = this._dragOrigin, dx = x - o.startX, dy = y - o.startY;
      const t1 = xToTime(o.p1x + dx), pr1 = yToPrice(o.p1y + dy), t2 = xToTime(o.p2x + dx), pr2 = yToPrice(o.p2y + dy);
      if (t1 !== null && pr1 !== null) this.p1 = { time: t1, price: pr1 };
      if (t2 !== null && pr2 !== null) this.p2 = { time: t2, price: pr2 };
    }
    this.refresh();
  }
  endDrag() { this._dragOrigin = null; }
}

class PnLBox extends DraggablePrimitive {
  constructor(t1, t2, entry, tp, sl) { super(); this.t1 = t1; this.t2 = t2; this.entry = entry; this.tp = tp; this.sl = sl; this._dragOrigin = null; }
  draw(target) {
    const xL = timeToX(this.t1), xR = timeToX(this.t2), yE = priceToY(this.entry), yTp = priceToY(this.tp), ySl = priceToY(this.sl);
    if ([xL, xR, yE, yTp, ySl].some((v) => v === null)) return;
    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context;
      const bxL = bitX(scope, Math.min(xL, xR)), bxR = bitX(scope, Math.max(xL, xR));
      ctx.save();
      ctx.fillStyle = 'rgba(30,217,165,0.22)';
      ctx.fillRect(bxL, bitY(scope, Math.min(yE, yTp)), bxR - bxL, Math.abs(bitY(scope, yTp) - bitY(scope, yE)));
      ctx.fillStyle = 'rgba(240,69,92,0.22)';
      ctx.fillRect(bxL, bitY(scope, Math.min(yE, ySl)), bxR - bxL, Math.abs(bitY(scope, ySl) - bitY(scope, yE)));
      const drawLine = (y, color, dashed) => {
        ctx.beginPath();
        ctx.setLineDash(dashed ? [6 * scope.horizontalPixelRatio, 4 * scope.horizontalPixelRatio] : []);
        ctx.strokeStyle = color; ctx.lineWidth = 1.5 * scope.verticalPixelRatio;
        ctx.moveTo(bxL, bitY(scope, y)); ctx.lineTo(bxR, bitY(scope, y)); ctx.stroke(); ctx.setLineDash([]);
      };
      drawLine(this.entry, '#E7E9EC', false); drawLine(this.tp, GREEN, true); drawLine(this.sl, RED, true);

      ctx.font = `bold ${9 * scope.verticalPixelRatio}px monospace`;
      ctx.textBaseline = 'middle';
      const label = (txt, y, color) => { ctx.fillStyle = color; ctx.fillText(txt, bxR + 4 * scope.horizontalPixelRatio, bitY(scope, y)); };
      label('E', this.entry, '#E7E9EC'); label('T', this.tp, GREEN); label('S', this.sl, RED);

      if (this.selected) {
        const dot = (x, y, color) => { ctx.beginPath(); ctx.arc(x, y, HANDLE_R * scope.horizontalPixelRatio, 0, Math.PI * 2); ctx.fillStyle = '#0A0C0F'; ctx.fill(); ctx.strokeStyle = color; ctx.lineWidth = 2 * scope.horizontalPixelRatio; ctx.stroke(); };
        [[this.entry, '#E7E9EC'], [this.tp, GREEN], [this.sl, RED]].forEach(([y, c]) => { dot(bxL, bitY(scope, y), c); dot(bxR, bitY(scope, y), c); });
        const topY = bitY(scope, Math.min(yE, yTp, ySl)), botY = bitY(scope, Math.max(yE, yTp, ySl));
        ctx.strokeStyle = BLUE; ctx.lineWidth = 1.5 * scope.horizontalPixelRatio;
        ctx.setLineDash([4 * scope.horizontalPixelRatio, 3 * scope.horizontalPixelRatio]);
        [bxL, bxR].forEach((x) => { ctx.beginPath(); ctx.moveTo(x, topY); ctx.lineTo(x, botY); ctx.stroke(); });
        ctx.setLineDash([]);
      }
      ctx.restore();
    });
  }
  hitTest(x, y) {
    const xL = timeToX(this.t1), xR = timeToX(this.t2), yE = priceToY(this.entry), yTp = priceToY(this.tp), ySl = priceToY(this.sl);
    if ([xL, xR, yE, yTp, ySl].some((v) => v === null)) return null;
    const minX = Math.min(xL, xR), maxX = Math.max(xL, xR);
    const inXRange = x >= minX - HIT_TOL && x <= maxX + HIT_TOL;
    if (inXRange) {
      if (Math.abs(y - yE) <= HIT_TOL) return 'entry';
      if (Math.abs(y - yTp) <= HIT_TOL) return 'tp';
      if (Math.abs(y - ySl) <= HIT_TOL) return 'sl';
    }
    const minY = Math.min(yE, yTp, ySl), maxY = Math.max(yE, yTp, ySl);
    const inYRange = y >= minY - HIT_TOL && y <= maxY + HIT_TOL;
    if (inYRange) {
      if (Math.abs(x - minX) <= HIT_TOL) return xL <= xR ? 'left' : 'right';
      if (Math.abs(x - maxX) <= HIT_TOL) return xL <= xR ? 'right' : 'left';
    }
    if (x >= minX && x <= maxX && y >= minY && y <= maxY) return 'body';
    return null;
  }
  beginDrag(handle, x, y) {
    if (handle === 'body') this._dragOrigin = { startX: x, startY: y, xL: timeToX(this.t1), xR: timeToX(this.t2), yE: priceToY(this.entry), yTp: priceToY(this.tp), ySl: priceToY(this.sl) };
  }
  drag(handle, x, y) {
    if (handle === 'entry') { const p = yToPrice(y); if (p !== null) this.entry = snapToTick(p); }
    else if (handle === 'tp') { const p = yToPrice(y); if (p !== null) this.tp = snapToTick(p); }
    else if (handle === 'sl') { const p = yToPrice(y); if (p !== null) this.sl = snapToTick(p); }
    else if (handle === 'left') { const t = xToTime(x); if (t !== null) this.t1 = t; }
    else if (handle === 'right') { const t = xToTime(x); if (t !== null) this.t2 = t; }
    else if (handle === 'body' && this._dragOrigin) {
      const o = this._dragOrigin, dx = x - o.startX, dy = y - o.startY;
      const t1 = xToTime(o.xL + dx), t2 = xToTime(o.xR + dx);
      const pe = yToPrice(o.yE + dy), pt = yToPrice(o.yTp + dy), ps = yToPrice(o.ySl + dy);
      if (t1 !== null) this.t1 = t1;
      if (t2 !== null) this.t2 = t2;
      if (pe !== null) this.entry = snapToTick(pe);
      if (pt !== null) this.tp = snapToTick(pt);
      if (ps !== null) this.sl = snapToTick(ps);
    }
    lastEditedPnlBox = this;
    this.refresh();
    renderReadout();
  }
  endDrag() { this._dragOrigin = null; }
}

// ===================== tool / selection state =====================
const primitives = [];
let activeTool = 'cursor';
let selected = null;
let dragging = null;
let creating = null;
let lastEditedPnlBox = null;

const hint = $('hint');
const toolButtons = document.querySelectorAll('.toolBtn[data-tool]');
function setTool(tool) {
  activeTool = tool;
  toolButtons.forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
  chartArea.style.cursor = tool === 'cursor' ? 'default' : 'crosshair';
  hint.textContent = {
    cursor: 'Tap a shape to select it, drag its handles to edit',
    trendline: 'Tap to place the start point, tap again to finish',
    box: 'Tap to place a corner, tap again for the opposite corner',
    pnl: 'Tap to drop a PnL box at that entry price',
  }[tool];
}
toolButtons.forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));

function select(p) {
  if (selected && selected !== p) { selected.selected = false; selected.refresh(); }
  selected = p;
  if (p) { p.selected = true; p.refresh(); if (p instanceof PnLBox) { lastEditedPnlBox = p; renderReadout(); } }
}
function deselectAll() { if (selected) { selected.selected = false; selected.refresh(); selected = null; } }
function addPrimitive(p) { primitives.push(p); series.attachPrimitive(p); return p; }
function removePrimitive(p) {
  const i = primitives.indexOf(p);
  if (i >= 0) primitives.splice(i, 1);
  series.detachPrimitive(p);
  if (selected === p) selected = null;
  if (lastEditedPnlBox === p) {
    const remaining = primitives.filter((x) => x instanceof PnLBox);
    lastEditedPnlBox = remaining.length ? remaining[remaining.length - 1] : null;
    renderReadout();
  }
}
function switchSymbolDrawings(symbol) {
  [...primitives].forEach(removePrimitive);
  loadDrawingsFor(symbol).forEach(addPrimitive);
  const boxes = primitives.filter((p) => p instanceof PnLBox);
  lastEditedPnlBox = boxes.length ? boxes[boxes.length - 1] : null;
  renderReadout();
}

$('deleteBtn').addEventListener('click', () => { if (selected) { removePrimitive(selected); saveDrawings(currentSymbol); } });
$('clearBtn').addEventListener('click', () => { [...primitives].forEach(removePrimitive); saveDrawings(currentSymbol); });

function setChartInteractive(enabled) {
  chart.applyOptions({
    handleScroll: enabled,
    handleScale: enabled ? { axisPressedMouseMove: { time: true, price: false }, pinch: true, mouseWheel: true, axisDoubleClickReset: true } : false,
  });
}
function getXY(clientX, clientY) { const rect = chartArea.getBoundingClientRect(); return { x: clientX - rect.left, y: clientY - rect.top }; }

function handlePointerDown(x, y, evt) {
  if (activeTool === 'cursor') {
    for (let i = primitives.length - 1; i >= 0; i--) {
      const hit = primitives[i].hitTest(x, y);
      if (hit) {
        select(primitives[i]);
        dragging = { primitive: primitives[i], handle: hit };
        primitives[i].beginDrag(hit, x, y);
        setChartInteractive(false);
        if (evt) evt.preventDefault();
        return;
      }
    }
    deselectAll();
    return;
  }
  if (evt) evt.preventDefault();
  const time = xToTime(x), price = yToPrice(y);
  if (time === null || price === null) return;

  if (activeTool === 'trendline') {
    if (!creating) creating = addPrimitive(new TrendLine({ time, price }, { time, price }));
    else { creating.p2 = { time, price }; creating.refresh(); creating = null; setTool('cursor'); saveDrawings(currentSymbol); }
  } else if (activeTool === 'box') {
    if (!creating) creating = addPrimitive(new BoxDrawing({ time, price }, { time, price }));
    else { creating.p2 = { time, price }; creating.refresh(); creating = null; setTool('cursor'); saveDrawings(currentSymbol); }
  } else if (activeTool === 'pnl') {
    const PNL_BOX_PIXEL_WIDTH = 90;
    const t2 = addPixels(x, PNL_BOX_PIXEL_WIDTH) ?? time;
    const slDist = price * (DEFAULT_SL_DISTANCE_PCT / 100);
    const snappedEntry = snapToTick(price);
    const box = addPrimitive(new PnLBox(time, t2, snappedEntry, snapToTick(price + slDist * 2), snapToTick(price - slDist)));
    select(box);
    setTool('cursor');
    saveDrawings(currentSymbol);
  }
}
function handlePointerMove(x, y, evt) {
  if (dragging) { if (evt) evt.preventDefault(); dragging.primitive.drag(dragging.handle, x, y); return; }
  if (creating) {
    if (evt) evt.preventDefault();
    const time = xToTime(x), price = yToPrice(y);
    if (time !== null && price !== null) { creating.p2 = { time, price }; creating.refresh(); }
    return;
  }
  if (activeTool === 'cursor') {
    let hovering = null;
    for (let i = primitives.length - 1; i >= 0 && !hovering; i--) hovering = primitives[i].hitTest(x, y);
    chartArea.style.cursor = hovering ? (hovering === 'body' ? 'move' : 'pointer') : 'default';
  }
}
function handlePointerUp() {
  if (dragging) { dragging.primitive.endDrag(); dragging = null; setChartInteractive(true); saveDrawings(currentSymbol); }
}
chartArea.addEventListener('mousedown', (e) => { const { x, y } = getXY(e.clientX, e.clientY); handlePointerDown(x, y, e); });
window.addEventListener('mousemove', (e) => { const { x, y } = getXY(e.clientX, e.clientY); handlePointerMove(x, y, e); });
window.addEventListener('mouseup', handlePointerUp);
chartArea.addEventListener('touchstart', (e) => { const t = e.touches[0]; if (!t) return; const { x, y } = getXY(t.clientX, t.clientY); handlePointerDown(x, y, e); }, { passive: false });
window.addEventListener('touchmove', (e) => { const t = e.touches[0]; if (!t) return; const { x, y } = getXY(t.clientX, t.clientY); handlePointerMove(x, y, e); }, { passive: false });
window.addEventListener('touchend', handlePointerUp, { passive: false });
window.addEventListener('touchcancel', handlePointerUp, { passive: false });
setTool('cursor');

// ===================== symbol / timeframe bootstrap =====================
const symbolLabelEl = $('symbolLabel');
const priceLabelEl = $('priceLabel');
const connStatusEl = $('connStatus');
let currentSymbol = 'BTCUSDT';
let currentTimeframe = '15m';
let currentInstrument = null;
let activeStream = null;
let lastDisplayedPrice = null;
let chartData = [];

function updatePriceLabel(price) {
  priceLabelEl.textContent = formatPrice(price);
  if (lastDisplayedPrice !== null) priceLabelEl.style.color = price >= lastDisplayedPrice ? GREEN : RED;
  lastDisplayedPrice = price;
}
function updateCountdown() {
  const real = chartData.filter((d) => d.open !== undefined);
  if (!real.length) return;
  const closeTime = (real[real.length - 1].time + barIntervalSeconds) * 1000;
  const remaining = Math.max(0, closeTime - Date.now());
  const totalSec = Math.floor(remaining / 1000);
  const hh = Math.floor(totalSec / 3600), mm = Math.floor((totalSec % 3600) / 60), ss = totalSec % 60;
  $('candleCountdown').textContent = hh > 0
    ? `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
    : `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}
setInterval(updateCountdown, 1000);

function applyLiveCandle(candle, isNewBar) {
  let realEnd = 0;
  while (realEnd < chartData.length && chartData[realEnd].open !== undefined) realEnd++;
  if (isNewBar) {
    if (realEnd < chartData.length) chartData[realEnd] = candle;
    else chartData.push(candle);
  } else if (realEnd > 0) {
    chartData[realEnd - 1] = candle;
  } else {
    chartData.unshift(candle);
  }
  series.setData(chartData);
}

function normalizeSymbol(input) {
  const clean = input.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!clean) return null;
  return clean.endsWith('USDT') ? clean : clean + 'USDT';
}

async function loadSymbol(symbol, timeframe) {
  setDebug(`Loading ${symbol} ${timeframe}…`);
  if (activeStream) { activeStream.close(); activeStream = null; }
  connStatusEl.className = 'connecting';

  try {
    const [klines, info] = await Promise.all([
      dataSource.fetchKlines(symbol, timeframe, 300),
      dataSource.getInstrumentInfo(symbol),
    ]);
    currentInstrument = info;
    currentTickSize = info.tickSize || 0.01;
    chartData = appendFutureWhitespace(klines, FUTURE_WHITESPACE_BARS);
    series.setData(chartData);
    chart.timeScale().fitContent();
    computeBarInterval(chartData);

    currentSymbol = symbol; currentTimeframe = timeframe;
    symbolLabelEl.textContent = symbol;
    lastDisplayedPrice = null;
    updatePriceLabel(klines[klines.length - 1].close);

    document.querySelectorAll('#timeframes button').forEach((b) => b.classList.toggle('active', b.dataset.tf === timeframe));
    switchSymbolDrawings(symbol);

    activeStream = dataSource.subscribeKlines(symbol, timeframe, {
      onCandle: (candle, isNewBar) => { applyLiveCandle(candle, isNewBar); updatePriceLabel(candle.close); updateCountdown(); },
      onStatus: (status) => { connStatusEl.className = status; connStatusEl.title = status === 'connected' ? 'Live' : status === 'connecting' ? 'Connecting…' : 'Disconnected — retrying…'; },
    }, klines[klines.length - 1]);

    const realCandles = chartData.filter((d) => d.open !== undefined).length;
    setDebug(`OK — ${symbol} ${timeframe}, ${realCandles} candles loaded${window.bybitApi ? ' (live)' : ' (mock)'}`);
  } catch (err) {
    setDebug('Data load failed: ' + err.message, true);
    console.error('Data load failed', err);
  }
}

TIMEFRAMES.forEach((tf) => {
  const btn = document.createElement('button');
  btn.textContent = tf;
  btn.dataset.tf = tf;
  if (tf === currentTimeframe) btn.classList.add('active');
  btn.addEventListener('click', () => loadSymbol(currentSymbol, tf));
  $('timeframes').appendChild(btn);
});
$('symbolInput').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const norm = normalizeSymbol(e.target.value);
  if (norm) loadSymbol(norm, currentTimeframe);
});

// ===================== risk panel / R:R / order flow =====================
let riskMode = 'usdt', riskValue = 0.1, balance = 842.17, usingLiveBalance = false;
$('balanceLabel').textContent = `Balance: ${balance.toFixed(2)} USDT`;
document.querySelectorAll('#riskModeToggle button').forEach((b) => {
  b.addEventListener('click', () => {
    riskMode = b.dataset.mode;
    document.querySelectorAll('#riskModeToggle button').forEach((x) => x.classList.toggle('active', x === b));
    renderReadout();
  });
});
$('riskValue').addEventListener('input', (e) => { riskValue = parseFloat(e.target.value) || 0; renderReadout(); });

function riskAmountUsdt() { return riskMode === 'usdt' ? riskValue : balance * (riskValue / 100); }
function pnlSide(box) {
  if (!box) return null;
  if (box.tp > box.entry && box.sl < box.entry) return 'long';
  if (box.tp < box.entry && box.sl > box.entry) return 'short';
  return 'invalid';
}
function computeRR(box) {
  if (!box) return null;
  const reward = Math.abs(box.tp - box.entry), risk = Math.abs(box.entry - box.sl);
  return risk === 0 ? 0 : reward / risk;
}
function computeQty(box) {
  if (!box) return null;
  const slDist = Math.abs(box.entry - box.sl);
  if (slDist === 0) return 0;
  return roundToStep(riskAmountUsdt() / slDist, currentInstrument?.qtyStep);
}

const readoutEl = $('readout');
function renderReadout() {
  const box = lastEditedPnlBox;
  if (!box) { readoutEl.innerHTML = ''; $('riskAmountLabel').textContent = ''; return; }
  const side = pnlSide(box), rr = computeRR(box), qty = computeQty(box);
  const sideColor = side === 'long' ? GREEN : side === 'short' ? RED : '#F5A623';
  const boxCount = primitives.filter((p) => p instanceof PnLBox).length;
  readoutEl.innerHTML = `
    <span>Active box side: <b style="color:${sideColor}">${side === 'invalid' ? 'invalid' : side.toUpperCase()}</b></span>
    <span>R:R <b style="color:${rr >= MIN_RR ? GREEN : RED}">1:${rr.toFixed(2)}</b> (min 1:${MIN_RR})</span>
    <span>Qty ≈ <b>${qty.toFixed(qtyDecimals())}</b> ${currentSymbol.replace('USDT', '')}</span>
    <span class="journalDim">${boxCount} box${boxCount === 1 ? '' : 'es'} on chart</span>
  `;
  $('riskAmountLabel').textContent = `risk ≈ ${riskAmountUsdt().toFixed(2)} USDT`;
}

let blockTimer = null;
function showBlock(msg) {
  const el = $('blockMsg');
  el.textContent = msg; el.classList.remove('hidden');
  clearTimeout(blockTimer); blockTimer = setTimeout(() => el.classList.add('hidden'), 4000);
}
function showToast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.remove('hidden');
  setTimeout(() => t.classList.add('hidden'), 3200);
}

async function attemptOrder(direction) {
  const box = lastEditedPnlBox;
  const side = pnlSide(box);
  if (!box || side === 'invalid') { showBlock('Place a PnL box (entry / TP / SL) before trading.'); return; }
  if ((direction === 'Long' && side !== 'long') || (direction === 'Short' && side !== 'short')) {
    showBlock(`Your most recently edited box is set up for ${side.toUpperCase()}. Adjust it or tap ${side === 'long' ? 'Long' : 'Short'} instead.`);
    return;
  }
  const rr = computeRR(box);
  if (rr < MIN_RR) { showBlock(`R:R is 1:${rr.toFixed(2)} — minimum is 1:${MIN_RR}. Trade not entered.`); return; }
  const qty = computeQty(box);
  if (currentInstrument?.minOrderQty && qty < currentInstrument.minOrderQty) {
    showBlock(`Position size (${qty}) is below ${currentSymbol}'s exchange minimum (${currentInstrument.minOrderQty}). Increase your risk amount or widen the SL.`);
    return;
  }
  const distancePct = (Math.abs(box.entry - lastDisplayedPrice) / lastDisplayedPrice) * 100;
  const orderType = distancePct <= THRESHOLD_PCT ? 'Market' : 'Limit';
  const orderPrice = orderType === 'Market' ? lastDisplayedPrice : box.entry;
  openConfirm({ direction, orderType, orderPrice, tp: box.tp, sl: box.sl, qty, rr, risk: riskAmountUsdt() });
}
$('longBtn').addEventListener('click', () => attemptOrder('Long'));
$('shortBtn').addEventListener('click', () => attemptOrder('Short'));

let pendingConfirm = null;
function openConfirm(order) {
  pendingConfirm = order;
  $('confirmTitle').textContent = `Confirm ${order.direction} — ${order.orderType}`;
  $('confirmRows').innerHTML = [
    ['Symbol', currentSymbol], ['Entry', fmt(order.orderPrice)], ['TP', fmt(order.tp)], ['SL', fmt(order.sl)],
    ['Qty', order.qty.toFixed(qtyDecimals())], ['R:R', `1:${order.rr.toFixed(2)}`], ['Risking', `${order.risk.toFixed(2)} USDT`],
  ].map(([l, v]) => `<div class="row"><span>${l}</span><span>${v}</span></div>`).join('');
  $('sendOrderBtn').className = 'tradeBtn ' + (order.direction === 'Long' ? 'long' : 'short');
  $('confirmModal').classList.remove('hidden');
}
$('cancelOrderBtn').addEventListener('click', () => $('confirmModal').classList.add('hidden'));
$('sendOrderBtn').addEventListener('click', async () => {
  $('confirmModal').classList.add('hidden');
  const o = pendingConfirm;
  const canSendLive = window.bybitApi?.hasNativeBridge && (await window.bybitApi.hasCredentials());
  logJournalEntry(o);
  if (!canSendLive) { showToast(`${o.direction} ${o.orderType} order placed (simulated) — ${currentSymbol}`); return; }
  try {
    await window.bybitApi.createOrder({
      symbol: currentSymbol, side: o.direction === 'Long' ? 'Buy' : 'Sell', orderType: o.orderType,
      qty: o.qty.toFixed(qtyDecimals()), price: o.orderPrice, takeProfit: o.tp, stopLoss: o.sl,
    });
    showToast(`${o.direction} ${o.orderType} order sent — ${currentSymbol}`);
    await refreshBalance();
  } catch (err) { showToast('Order failed: ' + err.message); }
});

// ===================== journal =====================
let journal = [];
function logJournalEntry(order) {
  journal.unshift({ id: Date.now(), time: Date.now(), symbol: currentSymbol, side: order.direction, orderType: order.orderType, entry: order.orderPrice, tp: order.tp, sl: order.sl, qty: order.qty, risk: order.risk, rr: order.rr });
  saveJournal();
}
function renderJournal() {
  const list = $('journalList');
  if (!journal.length) { list.innerHTML = `<div class="journalEmpty">No trades logged yet.</div>`; return; }
  list.innerHTML = journal.map((j) => {
    const d = new Date(j.time);
    const dateStr = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const sideColor = j.side === 'Long' ? GREEN : RED;
    return `<div class="journalRow">
      <div class="journalTop"><span style="color:${sideColor};font-weight:700">${j.side}</span><span>${j.symbol}</span><span class="journalDim">${j.orderType}</span><span class="journalDim">${dateStr}</span></div>
      <div class="journalBottom"><span>E ${formatPrice(j.entry)}</span><span style="color:${GREEN}">T ${formatPrice(j.tp)}</span><span style="color:${RED}">S ${formatPrice(j.sl)}</span><span>Qty ${j.qty}</span><span>R:R 1:${j.rr.toFixed(2)}</span></div>
    </div>`;
  }).join('');
}
$('journalBtn').addEventListener('click', () => { renderJournal(); $('journalModal').classList.remove('hidden'); });
$('closeJournalBtn').addEventListener('click', () => $('journalModal').classList.add('hidden'));
$('clearJournalBtn').addEventListener('click', () => { if (!confirm("Clear all journal entries? This can't be undone.")) return; journal = []; saveJournal(); renderJournal(); });

// ===================== landscape =====================
let landscape = false;
$('landscapeBtn').addEventListener('click', async () => {
  landscape = !landscape;
  document.body.classList.toggle('landscapeMode', landscape);
  const ScreenOrientation = window.Capacitor?.Plugins?.ScreenOrientation;
  if (ScreenOrientation) {
    try { landscape ? await ScreenOrientation.lock({ orientation: 'landscape' }) : await ScreenOrientation.unlock(); }
    catch (e) { console.warn('Could not lock orientation:', e.message); }
  }
  requestAnimationFrame(() => chart.resize(chartArea.clientWidth, chartArea.clientHeight));
});

// ===================== API key / balance =====================
async function refreshBalance() {
  if (window.bybitApi && (await window.bybitApi.hasCredentials())) {
    try {
      const result = await window.bybitApi.getWalletBalance();
      const usdt = result?.list?.[0]?.coin?.find((c) => c.coin === 'USDT');
      if (usdt) { balance = parseFloat(usdt.walletBalance) || 0; usingLiveBalance = true; }
    } catch (err) {
      console.warn('Balance fetch failed:', err.message);
      if (!usingLiveBalance) showToast('Live balance fetch failed — showing mock balance.');
    }
  }
  $('balanceLabel').textContent = `Balance: ${balance.toFixed(2)} USDT${usingLiveBalance ? '' : ' (mock)'}`;
  renderReadout();
}
async function initApiKeyFlow() {
  const has = window.bybitApi && (await window.bybitApi.hasCredentials());
  if (!has) $('apiKeyModal').classList.remove('hidden');
  await refreshBalance();
}
$('settingsBtn').addEventListener('click', () => $('apiKeyModal').classList.remove('hidden'));
$('skipKeyBtn').addEventListener('click', () => $('apiKeyModal').classList.add('hidden'));
$('saveKeyBtn').addEventListener('click', async () => {
  const apiKey = $('apiKeyInput').value.trim(), apiSecret = $('apiSecretInput').value.trim();
  if (!apiKey || !apiSecret) { showToast('Enter both API key and secret'); return; }
  if (!window.bybitApi?.hasNativeBridge) { showToast('Native bridge not available in this preview — build the app to store keys'); return; }
  try {
    await window.bybitApi.saveCredentials(apiKey, apiSecret);
    $('apiKeyInput').value = ''; $('apiSecretInput').value = '';
    $('apiKeyModal').classList.add('hidden');
    showToast('API key saved');
    await refreshBalance();
  } catch (err) { showToast('Failed to save key: ' + err.message); }
});

// ===================== init =====================
symbolLabelEl.textContent = currentSymbol;
loadJournal();
loadSymbol(currentSymbol, currentTimeframe);
initApiKeyFlow();

})();
