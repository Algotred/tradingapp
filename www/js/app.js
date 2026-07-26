(async function main() {
await window.__chartsReady; // wait for the CDN script to actually finish loading

/* data-source.js, persistence.js, trading.js, and primitives.js are loaded as
   separate <script> tags BEFORE this file — their classes/functions are already
   in scope here as plain globals (non-module scripts share one top-level scope). */

/* ============================================================
   1. COORDINATE HELPERS (declared first — used during initial data load below)
   ============================================================ */
// bar interval in seconds, derived from the actual data — used to extrapolate
// time values into the reserved future whitespace, where coordinateToTime()
// alone returns null because there's no real candle there yet.
let barIntervalSeconds = 86400;
function computeBarInterval(data) {
  if (data.length >= 2) barIntervalSeconds = data[data.length - 1].time - data[data.length - 2].time;
}

function timeToX(t) { return chart.timeScale().timeToCoordinate(t); }
function xToTime(x) {
  const t = chart.timeScale().coordinateToTime(x);
  if (t !== null) return t;
  // past the last loaded candle (future whitespace) — extrapolate from the
  // logical bar index instead, which stays valid past the data edge
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

// shift an x-coordinate by a fixed number of *screen pixels* and convert back
// to a time value — this is what keeps the PnL box a constant visual size
// regardless of zoom level, instead of a fixed bar-count (bug #3: 15 bars
// shrinks to nothing when zoomed out, or fills the screen when zoomed in).
function addPixels(xRef, pixels) { return xToTime(xRef + pixels); }

function bitX(scope, mediaX) { return Math.round(mediaX * scope.horizontalPixelRatio); }
function bitY(scope, mediaY) { return Math.round(mediaY * scope.verticalPixelRatio); }

const HANDLE_R = 5;       // px radius for the visible endpoint handle dot
const HIT_TOL = 14;       // px tolerance for hit-testing — generous for touch/fingertip accuracy

/* ============================================================
   5. CHART SETUP
   ============================================================ */
const debugLine = document.getElementById('debugLine');
function setDebug(text, isError) {
  debugLine.textContent = text;
  debugLine.style.color = isError ? '#ef5350' : '#787b86';
}

const container = document.getElementById('chart-container');
let chart, series;

try {
  chart = LightweightCharts.createChart(container, {
    layout: { background: { type: 'solid', color: '#131722' }, textColor: '#d1d4dc' },
    grid: { vertLines: { color: '#1e222d' }, horzLines: { color: '#1e222d' } },
    rightPriceScale: {
      borderColor: '#2a2e39',
      autoScale: true, // always fit the visible candle range — this is what prevents infinite vertical pan/zoom
    },
    timeScale: {
      borderColor: '#2a2e39', timeVisible: true,
      rightOffset: 20, // reserve empty space to the right of the last candle so there's room to draw ahead of price
    },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    handleScale: {
      axisPressedMouseMove: { time: true, price: false }, // disable manual price-axis drag entirely
      pinch: true, mouseWheel: true, axisDoubleClickReset: true,
    },
    width: container.clientWidth,
    height: container.clientHeight || 400,
  });

  // don't rely solely on ResizeObserver's async first callback — measure and
  // resize synchronously right now, in case the container's flex layout
  // hadn't settled to its final size at the moment createChart() ran
  chart.resize(container.clientWidth || 320, container.clientHeight || 400);

  // This whole app is written against the v4 API (addCandlestickSeries).
  // v5 removed it in favor of addSeries(SeriesType, options) — if the
  // bundled/CDN'd library is v5+, fail here with a specific, actionable
  // message instead of a generic crash three calls later.
  if (typeof chart.addCandlestickSeries !== 'function') {
    throw new Error(
      "Loaded lightweight-charts build doesn't have addCandlestickSeries — " +
      "this app needs v4.x (v5 renamed/removed this method). Check that " +
      "js/vendor/lightweight-charts.standalone.production.js was downloaded " +
      "as version 4.1.3, not an unpinned/latest URL."
    );
  }

  series = chart.addCandlestickSeries({
    upColor: '#26a69a', downColor: '#ef5350',
    borderVisible: false,
    wickUpColor: '#26a69a', wickDownColor: '#ef5350',
  });
} catch (err) {
  setDebug('Chart init failed: ' + err.message, true);
  console.error('Chart init failed', err);
  throw err;
}

// lightweight-charts' coordinateToTime()/coordinateToLogical() only resolve
// coordinates where an actual bar exists — they return null past the last
// real candle regardless of rightOffset (that only reserves visual margin,
// it doesn't make the area time-addressable). The library's own documented
// fix is WhitespaceData: time-only points with no OHLC, appended after the
// real data, which makes that future range genuinely interactive.
const FUTURE_WHITESPACE_BARS = 60;
function appendFutureWhitespace(data, n) {
  if (data.length < 2) return data;
  const interval = data[data.length - 1].time - data[data.length - 2].time;
  let t = data[data.length - 1].time;
  const extended = data.slice();
  for (let i = 0; i < n; i++) {
    t += interval;
    extended.push({ time: t }); // no open/high/low/close = whitespace point
  }
  return extended;
}

const symbolNameEl = document.getElementById('symbolName');
const lastPriceEl = document.getElementById('lastPrice');
const connStatusEl = document.getElementById('connStatus');
const savedSettings = loadSettings();
let currentSymbol = savedSettings.defaultSymbol || 'BTCUSDT';
let currentTimeframe = savedSettings.defaultTimeframe || '15m';
let activeStream = null;
let lastDisplayedPrice = null;

// Free-form coin entry, not a fixed list: normalizes casing and appends the
// USDT quote Bybit's linear perpetuals use, unless a recognized quote
// suffix is already present. "grass" / "GRASS" / "grassusdt" all resolve
// to the same GRASSUSDT — MockDataSource/BybitDataSource both already
// handle arbitrary unknown symbols gracefully (mock falls back to sane
// generic defaults; the real API just returns its own error if invalid,
// which our existing fallback logic already catches).
function normalizeSymbolInput(raw) {
  let s = (raw || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!s) return null;
  if (!s.endsWith('USDT') && !s.endsWith('USDC')) s += 'USDT';
  return s;
}

let pendingSymbolLoad = null; // guards against a duplicate in-flight load if Enter and blur both fire before loadSymbol resolves
function commitSymbolInput() {
  const normalized = normalizeSymbolInput(symbolNameEl.value);
  symbolNameEl.value = normalized || currentSymbol;
  if (normalized && normalized !== currentSymbol && normalized !== pendingSymbolLoad) {
    pendingSymbolLoad = normalized;
    loadSymbol(normalized, currentTimeframe).finally(() => { if (pendingSymbolLoad === normalized) pendingSymbolLoad = null; });
  }
}
symbolNameEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') commitSymbolInput(); });
symbolNameEl.addEventListener('blur', commitSymbolInput);

function updateLastPrice(price) {
  lastPriceEl.textContent = price.toFixed(currentTickSize < 1 ? 2 : 0);
  if (lastDisplayedPrice !== null) {
    lastPriceEl.classList.remove('up', 'down');
    lastPriceEl.classList.add(price >= lastDisplayedPrice ? 'up' : 'down');
  }
  lastDisplayedPrice = price;
}

let chartData = []; // real candles + trailing future-whitespace points, kept in sync with the series

// series.update() requires the new point's time to be >= the series' last
// existing point — but our series always ends with future whitespace points
// (deliberately, for the future-drawing feature), so a live tick at the
// *current* real time is always earlier than that and update() throws. We
// splice the live candle into the real-data prefix instead and re-set.
function applyLiveCandle(candle, isNewBar) {
  let realEnd = 0;
  while (realEnd < chartData.length && chartData[realEnd].open !== undefined) realEnd++;
  if (isNewBar) {
    // the first whitespace slot's time is always exactly last-real-time +
    // interval — i.e. it was already reserved for precisely this new bar.
    // Overwrite it in place rather than inserting, which would leave a
    // duplicate/out-of-order timestamp sitting right next to it.
    if (realEnd < chartData.length) chartData[realEnd] = candle;
    else chartData.push(candle); // no whitespace left (shouldn't normally happen)
  } else if (realEnd > 0) {
    chartData[realEnd - 1] = candle; // update the still-forming last real candle in place
  } else {
    chartData.unshift(candle);
  }
  series.setData(chartData);
}

// switchSymbolDrawings is defined later (near primitive management) and
// referenced here by name — safe because this function is only ever
// *called* after the whole script has finished defining everything below.
async function loadSymbol(symbol, timeframe) {
  const previousSymbol = currentSymbol;
  setDebug(`Loading ${symbol} ${timeframe}…`);
  if (activeStream) { activeStream.close(); activeStream = null; }
  connStatusEl.className = 'connecting';

  try {
    const [klines, info] = await Promise.all([
      dataSource.fetchKlines(symbol, timeframe, 300),
      dataSource.getInstrumentInfo(symbol),
    ]);
    currentTickSize = info.tickSize;
    chartData = appendFutureWhitespace(klines, FUTURE_WHITESPACE_BARS);
    series.setData(chartData);
    chart.timeScale().fitContent();
    computeBarInterval(chartData);

    currentSymbol = symbol;
    currentTimeframe = timeframe;
    symbolNameEl.value = symbol;
    lastDisplayedPrice = null;
    updateLastPrice(klines[klines.length - 1].close);

    document.querySelectorAll('.tf-btn').forEach(b => b.classList.toggle('active', b.dataset.tf === timeframe));
    // only reload drawings if the symbol actually changed — a timeframe-only
    // switch has no reason to detach/reattach the same symbol's drawings
    if (symbol !== previousSymbol && typeof switchSymbolDrawings === 'function') switchSymbolDrawings(symbol);

    activeStream = dataSource.subscribeKlines(symbol, timeframe, {
      onCandle: (candle, isNewBar) => { applyLiveCandle(candle, isNewBar); updateLastPrice(candle.close); },
      onStatus: (status) => {
        connStatusEl.className = status;
        connStatusEl.title = status === 'connected' ? 'Live' : status === 'connecting' ? 'Connecting…' : 'Disconnected — retrying…';
      },
    }, klines[klines.length - 1]);

    const realCandles = chartData.filter(d => d.open !== undefined).length;
    setDebug(`OK — ${symbol} ${timeframe}, ${realCandles} candles + ${FUTURE_WHITESPACE_BARS} future slots, container ${container.clientWidth}x${container.clientHeight}px${STORAGE_WORKS ? '' : ' — ⚠ localStorage unavailable, drawings/settings will not persist here'}`, !STORAGE_WORKS);
  } catch (err) {
    setDebug('Data load failed: ' + err.message, true);
    console.error('Data load failed', err);
  }
}

new ResizeObserver(entries => {
  const { width, height } = entries[0].contentRect;
  chart.resize(width, height);
}).observe(container);


/* ============================================================
   7. TOOL / SELECTION / DRAG STATE MANAGEMENT
   ============================================================ */
const primitives = [];
let activeTool = 'cursor';
let selected = null;
let dragging = null;        // { primitive, handle }
let creating = null;        // primitive currently being placed (trendline/box ghost)

const hint = document.getElementById('hint');
const toolButtons = document.querySelectorAll('.tool-btn[data-tool]');

function setTool(tool) {
  activeTool = tool;
  toolButtons.forEach(b => b.classList.toggle('active', b.dataset.tool === tool));
  container.style.cursor = tool === 'cursor' ? 'default' : 'crosshair';
  hint.textContent = {
    cursor: 'Click a shape to select it, drag its handles to edit',
    trendline: 'Click to place the start point, click again to finish',
    box: 'Click to place a corner, click again for the opposite corner',
    pnl: 'Click to drop a PnL box at that entry price',
  }[tool];
}
toolButtons.forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));

function select(p) {
  if (selected && selected !== p) { selected.selected = false; selected.refresh(); }
  selected = p;
  if (p) { p.selected = true; p.refresh(); }
}
function deselectAll() { if (selected) { selected.selected = false; selected.refresh(); selected = null; } }

function addPrimitive(p) {
  primitives.push(p);
  series.attachPrimitive(p);
  return p;
}
function removePrimitive(p) {
  const i = primitives.indexOf(p);
  if (i >= 0) primitives.splice(i, 1);
  series.detachPrimitive(p);
  if (selected === p) selected = null;
}

// swaps out every on-chart drawing for the ones persisted under the new
// symbol — called by loadSymbol() whenever the symbol changes
function switchSymbolDrawings(symbol) {
  [...primitives].forEach(removePrimitive);
  loadDrawings(symbol).forEach(addPrimitive);
}

document.getElementById('deleteBtn').addEventListener('click', () => {
  if (selected) { removePrimitive(selected); saveDrawings(currentSymbol); }
});
document.getElementById('clearBtn').addEventListener('click', () => {
  [...primitives].forEach(removePrimitive);
  saveDrawings(currentSymbol);
});

/* ---- pointer handling (mouse + touch) on the chart's own container ----
   Shared logic lives in handlePointerDown/Move/Up; mouse and touch events
   both funnel through them.

   Chart lock strategy: selecting a shape does NOT lock the chart — you can
   still pan/zoom freely with one selected. The chart is only locked for the
   exact duration of an active drag (handle grab or tool creation), then
   unlocked immediately on release. This is done by directly toggling the
   library's own handleScroll/handleScale options rather than relying on
   preventDefault()/event order, which isn't reliable against the library's
   internal touch handlers on its own canvas. */
function setChartInteractive(enabled) {
  chart.applyOptions({
    handleScroll: enabled,
    handleScale: enabled ? { axisPressedMouseMove: { time: true, price: false }, pinch: true, mouseWheel: true, axisDoubleClickReset: true } : false,
  });
}

function getXY(clientX, clientY) {
  const rect = container.getBoundingClientRect();
  return { x: clientX - rect.left, y: clientY - rect.top };
}

function handlePointerDown(x, y, evt) {
  if (activeTool === 'cursor') {
    for (let i = primitives.length - 1; i >= 0; i--) {
      const hit = primitives[i].hitTest(x, y);
      if (hit) {
        if (primitives[i] !== selected) {
          // first touch on an unselected shape: select it only — do NOT
          // start a drag or block the gesture, so the chart still pans/zooms
          // normally underneath this same touch. You have to tap it once
          // (making it selected) before a second touch can actually move it.
          select(primitives[i]);
          return;
        }
        // already selected — this touch is a real drag
        dragging = { primitive: primitives[i], handle: hit };
        primitives[i].beginDrag(hit, x, y);
        setChartInteractive(false); // lock pan/zoom only now, for the duration of this drag
        if (evt) evt.preventDefault();
        return;
      }
    }
    deselectAll();
    return;
  }

  // creation modes (discrete tap-to-place, not a held drag) — chart stays
  // interactive between the two taps, e.g. so you can pan to a distant point
  if (evt) evt.preventDefault();
  const time = xToTime(x), price = yToPrice(y);
  if (time === null || price === null) {
    console.warn('Could not place point: xToTime/yToPrice returned null', { x, y, time, price });
    return;
  }

  if (activeTool === 'trendline') {
    if (!creating) {
      creating = addPrimitive(new TrendLine({ time, price }, { time, price }));
    } else {
      creating.p2 = { time, price };
      creating.refresh();
      creating = null;
      setTool('cursor');
      saveDrawings(currentSymbol);
    }
  } else if (activeTool === 'box') {
    if (!creating) {
      creating = addPrimitive(new BoxDrawing({ time, price }, { time, price }));
    } else {
      creating.p2 = { time, price };
      creating.refresh();
      creating = null;
      setTool('cursor');
      saveDrawings(currentSymbol);
    }
  } else if (activeTool === 'pnl') {
    const PNL_BOX_PIXEL_WIDTH = 90; // constant on-screen size at any zoom level
    const t2 = addPixels(x, PNL_BOX_PIXEL_WIDTH) ?? time; // ?? only hits if the chart has zero data at all
    const snappedEntry = snapToTick(price);
    const s = loadSettings();
    const tpPct = (s.defaultTpPct ?? 2.0) / 100;
    const slPct = (s.defaultSlPct ?? 1.0) / 100;
    const box = addPrimitive(new PnLBox(time, t2, snappedEntry, snapToTick(price * (1 + tpPct)), snapToTick(price * (1 - slPct))));
    lastEditedPnLBox = box;
    select(box);
    setTool('cursor');
    saveDrawings(currentSymbol);
  }
}

function handlePointerMove(x, y, evt) {
  if (dragging) {
    if (evt) evt.preventDefault();
    dragging.primitive.drag(dragging.handle, x, y);
    return;
  }
  if (creating) {
    if (evt) evt.preventDefault();
    const time = xToTime(x), price = yToPrice(y);
    if (time !== null && price !== null) {
      creating.p2 = { time, price };
      creating.refresh();
    }
    return;
  }
  // hover feedback in cursor mode (mouse only — touch has no hover state)
  if (activeTool === 'cursor') {
    let hovering = null;
    for (let i = primitives.length - 1; i >= 0 && !hovering; i--) {
      hovering = primitives[i].hitTest(x, y);
    }
    container.style.cursor = hovering ? (hovering === 'body' ? 'move' : 'pointer') : 'default';
  }
}

function handlePointerUp() {
  if (dragging) {
    dragging.primitive.endDrag();
    if (dragging.primitive instanceof PnLBox) lastEditedPnLBox = dragging.primitive;
    dragging = null;
    setChartInteractive(true); // release the lock the instant the drag ends
    saveDrawings(currentSymbol);
  }
}


// mouse
container.addEventListener('mousedown', (e) => {
  const { x, y } = getXY(e.clientX, e.clientY);
  handlePointerDown(x, y, e);
});
window.addEventListener('mousemove', (e) => {
  const { x, y } = getXY(e.clientX, e.clientY);
  handlePointerMove(x, y, e);
});
window.addEventListener('mouseup', handlePointerUp);

// touch — { passive: false } is required so preventDefault() is allowed to work
container.addEventListener('touchstart', (e) => {
  const t = e.touches[0];
  if (!t) return;
  const { x, y } = getXY(t.clientX, t.clientY);
  handlePointerDown(x, y, e);
}, { passive: false });

window.addEventListener('touchmove', (e) => {
  const t = e.touches[0];
  if (!t) return;
  const { x, y } = getXY(t.clientX, t.clientY);
  handlePointerMove(x, y, e);
}, { passive: false });

window.addEventListener('touchend', handlePointerUp, { passive: false });
window.addEventListener('touchcancel', handlePointerUp, { passive: false });

setTool('cursor');

/* ============================================================
   8. RISK PANEL & CONFIRMATION MODAL
   ------------------------------------------------------------
   Confirm now goes through the real, correctly-signed BybitOrderClient —
   it just has no live keys by default, so every call simulates.
   ============================================================ */
let mockBalance = savedSettings.mockBalance ?? 10000; // used both as the simulated balance and the fallback display
async function refreshBalanceDisplay() {
  try {
    const resp = await orderClient.getWalletBalance();
    if (resp.retCode === 0 && resp.result.list?.length) {
      const bal = Number(resp.result.list[0].totalAvailableBalance);
      document.getElementById('balanceValue').textContent = bal.toFixed(2) + ' USDT';
      document.getElementById('simBadge').style.display = orderClient.isLive ? 'none' : '';
      if (orderClient.isLive) mockBalance = bal; // keep risk math consistent with whatever's actually displayed
      return;
    }
  } catch (err) { console.warn('refreshBalanceDisplay failed:', err); }
  document.getElementById('balanceValue').textContent = mockBalance.toFixed(2) + ' USDT';
}
refreshBalanceDisplay();

let riskMode = savedSettings.riskMode || 'usdt';
let riskValue = savedSettings.riskValue ?? 1;
document.getElementById('riskValueInput').value = riskValue;

document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    riskMode = btn.dataset.mode;
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('active', b === btn));
    saveSettings({ riskMode });
  });
});
document.getElementById('riskValueInput').addEventListener('change', (e) => {
  riskValue = parseFloat(e.target.value) || 0;
  saveSettings({ riskValue });
});

const modalOverlay = document.getElementById('modalOverlay');
const modalBody = document.getElementById('modalBody');
const modalConfirm = document.getElementById('modalConfirm');
let pendingTrade = null;

function closeModal() { modalOverlay.classList.remove('open'); pendingTrade = null; }

async function openConfirmModal(side) {
  const box = getActivePnLBox();
  if (!box) {
    setDebug('No PnL box selected — draw or select one first.', true);
    return;
  }
  const info = await dataSource.getInstrumentInfo(currentSymbol);
  const currentPrice = lastDisplayedPrice ?? box.entry; // fall back if no tick has arrived yet
  pendingTrade = computeTradeParams(box, side, riskMode, riskValue, mockBalance, currentPrice, info);
  renderModal(pendingTrade);
  modalOverlay.classList.add('open');
}

function renderModal(p) {
  document.getElementById('modalTitle').textContent = `Confirm ${p.side.toUpperCase()} — ${p.orderType}`;
  const row = (k, v, cls) => `<div class="row"><span class="k">${k}</span><span class="v${cls ? ' ' + cls : ''}">${v}</span></div>`;
  let html = '';
  html += row('Symbol', p.symbol);
  html += row('Side', p.side.toUpperCase(), p.side);
  html += row('Order Type', p.orderType);
  html += row('Quantity', p.qty);
  html += row('Notional', p.notional.toFixed(2) + ' USDT');
  html += row('Risking', p.riskAmount.toFixed(2) + ' USDT');
  html += row('Net R:R', '1 : ' + p.netRR.toFixed(2));
  html += row('Fees (Entry/TP/SL)', `${p.entryFee.toFixed(2)} / ${p.tpFee.toFixed(2)} / ${p.slFee.toFixed(2)}`);
  html += row('Leverage', p.requiredLeverage.toFixed(1) + 'x (max ' + p.maxLeverage + 'x)');
  if (p.errors.length) html += '<div class="warn">' + p.errors.map(e => '⚠ ' + e).join('<br>') + '</div>';
  modalBody.innerHTML = html;
  modalConfirm.disabled = !p.valid;
  modalConfirm.textContent = 'Confirm';
}

document.getElementById('longBtn').addEventListener('click', () => openConfirmModal('long'));
document.getElementById('shortBtn').addEventListener('click', () => openConfirmModal('short'));
document.getElementById('modalClose').addEventListener('click', closeModal);
document.getElementById('modalCancel').addEventListener('click', closeModal);
document.getElementById('modalConfirm').addEventListener('click', async () => {
  if (!pendingTrade || !pendingTrade.valid) return;
  const p = pendingTrade;
  modalConfirm.disabled = true;
  modalConfirm.textContent = 'Placing…';
  try {
    // required leverage gets set BEFORE the order per spec, then injected via the order's implicit leverage
    const levResp = await orderClient.setLeverage(p.symbol, Math.ceil(p.requiredLeverage));
    if (levResp.retCode !== 0) throw new Error('setLeverage: ' + levResp.retMsg);
    const orderResp = await orderClient.createOrder(p);
    if (orderResp.retCode !== 0) throw new Error('createOrder: ' + orderResp.retMsg);
    const mode = orderClient.isLive ? 'LIVE' : 'SIMULATED';
    console.log(`[${mode} ORDER PLACED]`, { params: p, orderId: orderResp.result.orderId });
    setDebug(`${mode}: ${p.side.toUpperCase()} order ${orderResp.result.orderId} placed for ${p.symbol}.`);
    closeModal();
  } catch (err) {
    console.error('Order placement failed:', err);
    setDebug('Order failed: ' + err.message, true);
    modalConfirm.disabled = false;
    modalConfirm.textContent = 'Confirm';
  }
});

/* ============================================================
   9. TRADE JOURNAL
   ------------------------------------------------------------
   Entries only ever get created once Bybit (real or simulated)
   reports an order as Filled — nothing pending/unfilled appears
   here. Reconciled on load and periodically thereafter.
   loadJournal/saveJournal now live in persistence.js.
   ============================================================ */
async function reconcileJournal() {
  try {
    const resp = await orderClient.getOrderHistory(currentSymbol);
    if (resp.retCode !== 0) return;
    const journal = loadJournal();
    const existingIds = new Set(journal.map(j => j.orderId));
    let added = false;
    for (const o of resp.result.list) {
      if (o.orderStatus === 'Filled' && !existingIds.has(o.orderId)) {
        journal.unshift({
          orderId: o.orderId, symbol: o.symbol, side: o.side === 'Buy' ? 'long' : 'short',
          qty: Number(o.qty), entry: Number(o.avgPrice), closePrice: Number(o.closePrice),
          realizedPnl: Number(o.realizedPnl), closedAt: Number(o.updatedTime),
        });
        added = true;
      }
    }
    if (added) saveJournal(journal);
  } catch (err) { console.warn('reconcileJournal failed', err); }
}

function renderJournal() {
  const journal = loadJournal();
  const body = document.getElementById('journalBody');
  if (!journal.length) { body.innerHTML = '<div class="journal-empty">No filled trades yet.</div>'; return; }
  body.innerHTML = journal.map(j => {
    const win = j.realizedPnl >= 0;
    const date = new Date(j.closedAt).toLocaleString();
    return `<div class="journal-entry">
      <div class="je-main">
        <span class="je-symbol">${j.symbol} · ${j.side.toUpperCase()}</span>
        <span class="je-detail">${j.entry.toFixed(2)} → ${j.closePrice.toFixed(2)} · qty ${j.qty} · ${date}</span>
      </div>
      <span class="je-pnl ${win ? 'win' : 'loss'}">${win ? '+' : ''}${j.realizedPnl.toFixed(2)}</span>
    </div>`;
  }).join('');
}

document.getElementById('journalBtn').addEventListener('click', async () => {
  await reconcileJournal();
  renderJournal();
  document.getElementById('journalOverlay').classList.add('open');
});
document.getElementById('journalClose').addEventListener('click', () => {
  document.getElementById('journalOverlay').classList.remove('open');
});

// reconcile on launch and periodically thereafter, per spec
reconcileJournal();
setInterval(reconcileJournal, 15000);

/* ============================================================
   10. SETTINGS MODAL
   ============================================================ */
const settingsOverlay = document.getElementById('settingsOverlay');
let settingsRiskMode = riskMode; // local staged copy until Save is pressed

// #chart-container already fills 100% of the fixed viewport via flex:1 — it's
// the only flexible element, so it's already at its natural maximum within
// one screen. The only way to make it genuinely *bigger* is to let the whole
// page grow taller than one viewport and scroll. With no scale set (the
// default), nothing here runs and behavior is pixel-identical to before.
function applyChartHeightScale(scale) {
  const appEl = document.getElementById('app');
  if (scale === null || scale === undefined || isNaN(scale)) {
    container.style.minHeight = '';
    appEl.style.height = '';
    appEl.style.minHeight = '';
    document.body.style.overflowY = '';
    document.documentElement.style.overflowY = '';
  } else {
    const clamped = Math.max(1, Math.min(10, scale));
    container.style.minHeight = (clamped * 8) + 'vh'; // 1->8vh .. 10->80vh, additive on top of the rest of the layout
    appEl.style.height = 'auto';
    appEl.style.minHeight = '100%';
    document.body.style.overflowY = 'auto';
    document.documentElement.style.overflowY = 'auto';
  }
  // the existing ResizeObserver on chart-container picks up this size change
  // and calls chart.resize() reactively — no need to trigger it manually here
}

function openSettings() {
  const s = loadSettings();
  document.getElementById('setDefaultSymbol').value = s.defaultSymbol || currentSymbol;

  const tfSel = document.getElementById('setDefaultTimeframe');
  tfSel.innerHTML = TIMEFRAMES.map(tf => `<option value="${tf}"${tf === currentTimeframe ? ' selected' : ''}>${tf}</option>`).join('');

  settingsRiskMode = s.riskMode || riskMode;
  document.querySelectorAll('#setRiskModeToggle .mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === settingsRiskMode));
  document.getElementById('setRiskValue').value = s.riskValue ?? riskValue;
  document.getElementById('setDefaultTpPct').value = (s.defaultTpPct ?? 2.0);
  document.getElementById('setDefaultSlPct').value = (s.defaultSlPct ?? 1.0);
  document.getElementById('setChartHeightScale').value = s.chartHeightScale ?? '';
  document.getElementById('setApiKey').value = orderClient.apiKey;
  document.getElementById('setApiSecret').value = orderClient.apiSecret;

  settingsOverlay.classList.add('open');
}
document.getElementById('settingsBtn').addEventListener('click', openSettings);
document.getElementById('settingsClose').addEventListener('click', () => settingsOverlay.classList.remove('open'));
document.querySelectorAll('#setRiskModeToggle .mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    settingsRiskMode = btn.dataset.mode;
    document.querySelectorAll('#setRiskModeToggle .mode-btn').forEach(b => b.classList.toggle('active', b === btn));
  });
});

document.getElementById('settingsSave').addEventListener('click', () => {
  const newSymbol = normalizeSymbolInput(document.getElementById('setDefaultSymbol').value) || currentSymbol;
  const newTimeframe = document.getElementById('setDefaultTimeframe').value;
  const newRiskValue = parseFloat(document.getElementById('setRiskValue').value) || 0;
  const newTpPct = parseFloat(document.getElementById('setDefaultTpPct').value) || 2.0;
  const newSlPct = parseFloat(document.getElementById('setDefaultSlPct').value) || 1.0;
  const rawScale = document.getElementById('setChartHeightScale').value.trim();
  const newChartHeightScale = rawScale === '' ? null : parseFloat(rawScale);

  saveSettings({
    defaultSymbol: newSymbol, defaultTimeframe: newTimeframe,
    riskMode: settingsRiskMode, riskValue: newRiskValue,
    defaultTpPct: newTpPct, defaultSlPct: newSlPct,
    chartHeightScale: newChartHeightScale,
  });
  applyChartHeightScale(newChartHeightScale);

  // apply immediately, session-memory only — never written to localStorage
  orderClient.apiKey = document.getElementById('setApiKey').value.trim();
  orderClient.apiSecret = document.getElementById('setApiSecret').value.trim();

  // reflect the new risk defaults in the always-visible risk bar too
  riskMode = settingsRiskMode;
  riskValue = newRiskValue;
  document.querySelectorAll('#riskModeToggle .mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === riskMode));
  document.getElementById('riskValueInput').value = riskValue;

  refreshBalanceDisplay();
  settingsOverlay.classList.remove('open');

  if (newSymbol !== currentSymbol || newTimeframe !== currentTimeframe) loadSymbol(newSymbol, newTimeframe);
});

/* ============================================================
   11. BOOTSTRAP — timeframe row + initial data load
   ============================================================ */
const tfRow = document.getElementById('tfRow');
TIMEFRAMES.forEach(tf => {
  const btn = document.createElement('button');
  btn.className = 'tf-btn' + (tf === currentTimeframe ? ' active' : '');
  btn.dataset.tf = tf;
  btn.textContent = tf;
  btn.addEventListener('click', () => loadSymbol(currentSymbol, tf));
  tfRow.appendChild(btn);
});

symbolNameEl.value = currentSymbol;
if (savedSettings.chartHeightScale != null) applyChartHeightScale(savedSettings.chartHeightScale);
loadSymbol(currentSymbol, currentTimeframe);

const countdownBadge = new CandleCountdownBadge();
series.attachPrimitive(countdownBadge);
setInterval(() => countdownBadge.refresh(), 1000);

})(); // end main()
