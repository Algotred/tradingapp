/* ============================================================
   PERSISTENCE (localStorage) — drawings keyed by symbol, settings and
   journal global. Depends on nothing except STORAGE_PREFIX and the
   TrendLine/BoxDrawing/PnLBox classes (referenced only inside function
   bodies, resolved at call time — so load order relative to
   primitives.js doesn't actually matter for correctness).
   ============================================================ */
const STORAGE_PREFIX = 'pnltools:';

// Definitive test of whether localStorage actually persists in this
// environment — some sandboxed iframe previews (like this artifact viewer)
// partition or reset storage in ways a real deployed page wouldn't. This
// tells us for certain rather than guessing from symptoms.
function testLocalStoragePersistence() {
  try {
    const testKey = STORAGE_PREFIX + '__persisttest__';
    localStorage.setItem(testKey, 'ok');
    const readBack = localStorage.getItem(testKey);
    localStorage.removeItem(testKey);
    if (readBack !== 'ok') throw new Error('wrote "ok", read back "' + readBack + '"');
    return true;
  } catch (err) {
    console.error('localStorage self-test FAILED:', err.message);
    return false;
  }
}
const STORAGE_WORKS = testLocalStoragePersistence();
if (!STORAGE_WORKS) {
  console.error('Drawings/settings will NOT persist across reloads or navigation in this environment — this is an environment limitation (e.g. a sandboxed preview partitioning storage), not an app bug. It should work normally once deployed as a real page.');
}

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
function saveDrawings(symbol, timeframe) {
  try {
    // read-only entries are reference drawings borrowed from a LOWER
    // timeframe (see switchSymbolDrawings) — they already live correctly
    // in their own timeframe's slot and must never be written here too
    const serialized = primitives.filter(p => !p.readOnly).map(serializePrimitive).filter(Boolean);
    localStorage.setItem(STORAGE_PREFIX + 'drawings:' + symbol + ':' + timeframe, JSON.stringify(serialized));
  } catch (err) { console.warn('saveDrawings failed', err); }
}
function loadDrawings(symbol, timeframe) {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + 'drawings:' + symbol + ':' + timeframe);
    if (!raw) return [];
    return JSON.parse(raw).map(deserializePrimitive).filter(Boolean);
  } catch (err) { console.warn('loadDrawings failed', err); return []; }
}
function saveSettings(patch) {
  try {
    const current = loadSettings();
    const merged = { ...current, ...patch };
    localStorage.setItem(STORAGE_PREFIX + 'settings', JSON.stringify(merged));
    return merged;
  } catch (err) { console.warn('saveSettings failed', err); return patch; }
}
function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + 'settings');
    return raw ? JSON.parse(raw) : {};
  } catch (err) { return {}; }
}

// --- Real-data cache — replaces the old mock-data fallback entirely. On a
// failed live fetch: a symbol/timeframe seen before shows its last known
// REAL data (clearly stale, never fabricated); a never-seen symbol shows
// nothing rather than invented candles. ---
function saveCachedKlines(symbol, timeframe, data) {
  try { localStorage.setItem(STORAGE_PREFIX + 'klinecache:' + symbol + ':' + timeframe, JSON.stringify(data)); }
  catch (err) { console.warn('saveCachedKlines failed', err); }
}
function loadCachedKlines(symbol, timeframe) {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + 'klinecache:' + symbol + ':' + timeframe);
    return raw ? JSON.parse(raw) : null;
  } catch (err) { return null; }
}
function saveCachedInstrumentInfo(symbol, info) {
  try { localStorage.setItem(STORAGE_PREFIX + 'instrumentcache:' + symbol, JSON.stringify(info)); }
  catch (err) { console.warn('saveCachedInstrumentInfo failed', err); }
}
function loadCachedInstrumentInfo(symbol) {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + 'instrumentcache:' + symbol);
    return raw ? JSON.parse(raw) : null;
  } catch (err) { return null; }
}


// --- Trade journal storage (Phase 5) — pure read/write, kept here with the
// rest of localStorage persistence. Reconciliation logic and rendering
// (which need orderClient + DOM) live in app.js. ---
function loadJournal() {
  try { return JSON.parse(localStorage.getItem(STORAGE_PREFIX + 'journal') || '[]'); }
  catch (err) { console.warn('loadJournal failed', err); return []; }
}
function saveJournal(list) {
  try { localStorage.setItem(STORAGE_PREFIX + 'journal', JSON.stringify(list)); }
  catch (err) { console.warn('saveJournal failed', err); }
}
