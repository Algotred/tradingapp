/* ============================================================
   3. GEOMETRY HELPER
   ============================================================ */
function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx, cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/* ============================================================
   3. BASE CLASS — shared plumbing for every draggable primitive
   ============================================================ */
class DraggablePrimitive {
  constructor() {
    this.selected = false;
    this._chart = null;
    this._series = null;
    this._requestUpdate = null;
    this._paneView = { renderer: () => ({ draw: (target) => this.draw(target) }) };
  }
  attached(param) {
    this._chart = param.chart;
    this._series = param.series;
    this._requestUpdate = param.requestUpdate;
  }
  detached() {}
  updateAllViews() {}
  paneViews() { return [this._paneView]; }
  refresh() { if (this._requestUpdate) this._requestUpdate(); }
  // override in subclasses:
  draw(target) {}
  hitTest(x, y) { return null; }
  beginDrag(handle, x, y) {}
  drag(handle, x, y) {}
  endDrag() {}
}

/* ============================================================
   4. TRENDLINE
   ============================================================ */
class TrendLine extends DraggablePrimitive {
  constructor(p1, p2, color = '#2962ff') {
    super();
    this.p1 = p1; this.p2 = p2; this.color = color;
    this._dragOrigin = null;
  }
  draw(target) {
    const x1 = timeToX(this.p1.time), y1 = priceToY(this.p1.price);
    const x2 = timeToX(this.p2.time), y2 = priceToY(this.p2.price);
    if (x1 === null || y1 === null || x2 === null || y2 === null) return;
    target.useBitmapCoordinateSpace(scope => {
      const ctx = scope.context;
      ctx.save();
      ctx.strokeStyle = this.color;
      ctx.lineWidth = 2 * scope.horizontalPixelRatio;
      ctx.beginPath();
      ctx.moveTo(bitX(scope, x1), bitY(scope, y1));
      ctx.lineTo(bitX(scope, x2), bitY(scope, y2));
      ctx.stroke();
      if (this.selected) {
        [[x1, y1], [x2, y2]].forEach(([x, y]) => {
          ctx.beginPath();
          ctx.arc(bitX(scope, x), bitY(scope, y), HANDLE_R * scope.horizontalPixelRatio, 0, Math.PI * 2);
          ctx.fillStyle = '#131722';
          ctx.fill();
          ctx.lineWidth = 2 * scope.horizontalPixelRatio;
          ctx.strokeStyle = this.color;
          ctx.stroke();
        });
      }
      ctx.restore();
    });
  }
  hitTest(x, y) {
    const x1 = timeToX(this.p1.time), y1 = priceToY(this.p1.price);
    const x2 = timeToX(this.p2.time), y2 = priceToY(this.p2.price);
    if (x1 === null || y1 === null || x2 === null || y2 === null) return null;
    if (Math.hypot(x - x1, y - y1) <= HANDLE_R + HIT_TOL) return 'p1';
    if (Math.hypot(x - x2, y - y2) <= HANDLE_R + HIT_TOL) return 'p2';
    if (distToSegment(x, y, x1, y1, x2, y2) <= HIT_TOL) return 'body';
    return null;
  }
  beginDrag(handle, x, y) {
    if (handle === 'body') {
      this._dragOrigin = {
        startX: x, startY: y,
        p1x: timeToX(this.p1.time), p1y: priceToY(this.p1.price),
        p2x: timeToX(this.p2.time), p2y: priceToY(this.p2.price),
      };
    }
  }
  drag(handle, x, y) {
    if (handle === 'p1') { this.p1 = { time: xToTime(x) ?? this.p1.time, price: yToPrice(y) ?? this.p1.price }; }
    else if (handle === 'p2') { this.p2 = { time: xToTime(x) ?? this.p2.time, price: yToPrice(y) ?? this.p2.price }; }
    else if (handle === 'body' && this._dragOrigin) {
      const o = this._dragOrigin;
      const dx = x - o.startX, dy = y - o.startY;
      const t1 = xToTime(o.p1x + dx), pr1 = yToPrice(o.p1y + dy);
      const t2 = xToTime(o.p2x + dx), pr2 = yToPrice(o.p2y + dy);
      if (t1 !== null && pr1 !== null) this.p1 = { time: t1, price: pr1 };
      if (t2 !== null && pr2 !== null) this.p2 = { time: t2, price: pr2 };
    }
    this.refresh();
  }
  endDrag() { this._dragOrigin = null; }
}

/* ============================================================
   5. BOX
   ============================================================ */
class BoxDrawing extends DraggablePrimitive {
  constructor(p1, p2, color = '#2962ff') {
    super();
    this.p1 = p1; this.p2 = p2; this.color = color; // p1/p2 = any two opposite corners
    this._dragOrigin = null;
  }
  draw(target) {
    const x1 = timeToX(this.p1.time), y1 = priceToY(this.p1.price);
    const x2 = timeToX(this.p2.time), y2 = priceToY(this.p2.price);
    if (x1 === null || y1 === null || x2 === null || y2 === null) return;
    target.useBitmapCoordinateSpace(scope => {
      const ctx = scope.context;
      const bx1 = bitX(scope, Math.min(x1, x2)), bx2 = bitX(scope, Math.max(x1, x2));
      const by1 = bitY(scope, Math.min(y1, y2)), by2 = bitY(scope, Math.max(y1, y2));
      ctx.save();
      ctx.fillStyle = this.color + '2A';
      ctx.fillRect(bx1, by1, bx2 - bx1, by2 - by1);
      ctx.strokeStyle = this.color;
      ctx.lineWidth = 1.5 * scope.horizontalPixelRatio;
      ctx.strokeRect(bx1, by1, bx2 - bx1, by2 - by1);
      if (this.selected) {
        [[x1, y1], [x1, y2], [x2, y1], [x2, y2]].forEach(([x, y]) => {
          ctx.beginPath();
          ctx.arc(bitX(scope, x), bitY(scope, y), HANDLE_R * scope.horizontalPixelRatio, 0, Math.PI * 2);
          ctx.fillStyle = '#131722'; ctx.fill();
          ctx.strokeStyle = this.color; ctx.lineWidth = 2 * scope.horizontalPixelRatio; ctx.stroke();
        });
      }
      ctx.restore();
    });
  }
  hitTest(x, y) {
    const x1 = timeToX(this.p1.time), y1 = priceToY(this.p1.price);
    const x2 = timeToX(this.p2.time), y2 = priceToY(this.p2.price);
    if (x1 === null || y1 === null || x2 === null || y2 === null) return null;
    const minX = Math.min(x1, x2), maxX = Math.max(x1, x2);
    const minY = Math.min(y1, y2), maxY = Math.max(y1, y2);
    if (Math.hypot(x - x1, y - y1) <= HANDLE_R + HIT_TOL) return 'p1';
    if (Math.hypot(x - x2, y - y2) <= HANDLE_R + HIT_TOL) return 'p2';
    if (Math.hypot(x - x1, y - y2) <= HANDLE_R + HIT_TOL) return 'p1y2';
    if (Math.hypot(x - x2, y - y1) <= HANDLE_R + HIT_TOL) return 'p2y1';
    if (x >= minX && x <= maxX && y >= minY && y <= maxY) return 'body';
    return null;
  }
  beginDrag(handle, x, y) {
    if (handle === 'body') {
      this._dragOrigin = {
        startX: x, startY: y,
        p1x: timeToX(this.p1.time), p1y: priceToY(this.p1.price),
        p2x: timeToX(this.p2.time), p2y: priceToY(this.p2.price),
      };
    }
  }
  drag(handle, x, y) {
    if (handle === 'p1') this.p1 = { time: xToTime(x) ?? this.p1.time, price: yToPrice(y) ?? this.p1.price };
    else if (handle === 'p2') this.p2 = { time: xToTime(x) ?? this.p2.time, price: yToPrice(y) ?? this.p2.price };
    else if (handle === 'p1y2') { // top-right / bottom-left cross corner: x from p1, y from p2
      const t = xToTime(x); if (t !== null) this.p1 = { ...this.p1, time: t };
      const pr = yToPrice(y); if (pr !== null) this.p2 = { ...this.p2, price: pr };
    } else if (handle === 'p2y1') {
      const t = xToTime(x); if (t !== null) this.p2 = { ...this.p2, time: t };
      const pr = yToPrice(y); if (pr !== null) this.p1 = { ...this.p1, price: pr };
    } else if (handle === 'body' && this._dragOrigin) {
      const o = this._dragOrigin;
      const dx = x - o.startX, dy = y - o.startY;
      const t1 = xToTime(o.p1x + dx), pr1 = yToPrice(o.p1y + dy);
      const t2 = xToTime(o.p2x + dx), pr2 = yToPrice(o.p2y + dy);
      if (t1 !== null && pr1 !== null) this.p1 = { time: t1, price: pr1 };
      if (t2 !== null && pr2 !== null) this.p2 = { time: t2, price: pr2 };
    }
    this.refresh();
  }
  endDrag() { this._dragOrigin = null; }
}

/* ============================================================
   6. PNL BOX — entry / tp / sl lines + green/red zones, fully adjustable
   ============================================================ */
class PnLBox extends DraggablePrimitive {
  constructor(entryTime, entryTime2, entryPrice, tpPrice, slPrice) {
    super();
    this.t1 = entryTime;      // left edge
    this.t2 = entryTime2;     // right edge
    this.entry = entryPrice;
    this.tp = tpPrice;
    this.sl = slPrice;
    this._dragOrigin = null;
  }
  draw(target) {
    const xL = timeToX(this.t1), xR = timeToX(this.t2);
    const yE = priceToY(this.entry), yTp = priceToY(this.tp), ySl = priceToY(this.sl);
    if ([xL, xR, yE, yTp, ySl].some(v => v === null)) return;
    target.useBitmapCoordinateSpace(scope => {
      const ctx = scope.context;
      const bxL = bitX(scope, Math.min(xL, xR)), bxR = bitX(scope, Math.max(xL, xR));
      ctx.save();
      // green (win) zone: entry -> tp
      ctx.fillStyle = 'rgba(38,166,154,0.22)';
      ctx.fillRect(bxL, bitY(scope, Math.min(yE, yTp)), bxR - bxL, Math.abs(bitY(scope, yTp) - bitY(scope, yE)));
      // red (loss) zone: entry -> sl
      ctx.fillStyle = 'rgba(239,83,80,0.22)';
      ctx.fillRect(bxL, bitY(scope, Math.min(yE, ySl)), bxR - bxL, Math.abs(bitY(scope, ySl) - bitY(scope, yE)));

      const drawLine = (y, color, dashed) => {
        ctx.beginPath();
        ctx.setLineDash(dashed ? [6 * scope.horizontalPixelRatio, 4 * scope.horizontalPixelRatio] : []);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5 * scope.verticalPixelRatio;
        ctx.moveTo(bxL, bitY(scope, y));
        ctx.lineTo(bxR, bitY(scope, y));
        ctx.stroke();
        ctx.setLineDash([]);
      };
      drawLine(this.entry, '#d1d4dc', false);
      drawLine(this.tp, '#26a69a', true);
      drawLine(this.sl, '#ef5350', true);

      // Net R:R (fee-adjusted) — same formula the confirmation modal uses,
      // so you can size the box correctly before ever opening it. Falls
      // back to the current entry price if no live tick has arrived yet.
      ctx.font = `${11 * scope.verticalPixelRatio}px sans-serif`;
      ctx.textBaseline = 'middle';
      const currentPrice = (typeof lastDisplayedPrice !== 'undefined' && lastDisplayedPrice !== null) ? lastDisplayedPrice : this.entry;
      const rr = computeNetRR(this.entry, this.tp, this.sl, currentPrice);

      ctx.fillStyle = rr >= 2 ? '#26a69a' : '#787b86';
      ctx.fillText(`Net R:R 1:${rr.toFixed(2)}`, bxL, bitY(scope, Math.min(yTp, ySl)) - 14 * scope.verticalPixelRatio);

      // handles
      if (this.selected) {
        const dot = (x, y, color) => {
          ctx.beginPath();
          ctx.arc(x, y, HANDLE_R * scope.horizontalPixelRatio, 0, Math.PI * 2);
          ctx.fillStyle = '#131722'; ctx.fill();
          ctx.strokeStyle = color; ctx.lineWidth = 2 * scope.horizontalPixelRatio; ctx.stroke();
        };
        [['entry', this.entry, '#d1d4dc'], ['tp', this.tp, '#26a69a'], ['sl', this.sl, '#ef5350']].forEach(([, y, c]) => {
          dot(bxL, bitY(scope, y), c); dot(bxR, bitY(scope, y), c);
        });
        // left/right edges as real vertical lines spanning the box height —
        // draggable along their whole length, same as the horizontal lines
        const topY = bitY(scope, Math.min(yE, yTp, ySl)), botY = bitY(scope, Math.max(yE, yTp, ySl));
        ctx.strokeStyle = '#2962ff';
        ctx.lineWidth = 1.5 * scope.horizontalPixelRatio;
        ctx.setLineDash([4 * scope.horizontalPixelRatio, 3 * scope.horizontalPixelRatio]);
        [bxL, bxR].forEach(x => {
          ctx.beginPath();
          ctx.moveTo(x, topY);
          ctx.lineTo(x, botY);
          ctx.stroke();
        });
        ctx.setLineDash([]);
      }
      ctx.restore();
    });
  }
  hitTest(x, y) {
    const xL = timeToX(this.t1), xR = timeToX(this.t2);
    const yE = priceToY(this.entry), yTp = priceToY(this.tp), ySl = priceToY(this.sl);
    if ([xL, xR, yE, yTp, ySl].some(v => v === null)) return null;
    const minX = Math.min(xL, xR), maxX = Math.max(xL, xR);
    const inXRange = x >= minX - HIT_TOL && x <= maxX + HIT_TOL;

    // horizontal lines (only within box width)
    if (inXRange) {
      if (Math.abs(y - yE) <= HIT_TOL) return 'entry';
      if (Math.abs(y - yTp) <= HIT_TOL) return 'tp';
      if (Math.abs(y - ySl) <= HIT_TOL) return 'sl';
    }
    // vertical edges
    const minY = Math.min(yE, yTp, ySl), maxY = Math.max(yE, yTp, ySl);
    const inYRange = y >= minY - HIT_TOL && y <= maxY + HIT_TOL;
    if (inYRange) {
      if (Math.abs(x - minX) <= HIT_TOL) return xL <= xR ? 'left' : 'right';
      if (Math.abs(x - maxX) <= HIT_TOL) return xL <= xR ? 'right' : 'left';
    }
    // body
    if (x >= minX && x <= maxX && y >= minY && y <= maxY) return 'body';
    return null;
  }
  beginDrag(handle, x, y) {
    if (handle === 'body') {
      this._dragOrigin = {
        startX: x, startY: y,
        xL: timeToX(this.t1), xR: timeToX(this.t2),
        yE: priceToY(this.entry), yTp: priceToY(this.tp), ySl: priceToY(this.sl),
      };
    }
  }
  drag(handle, x, y) {
    if (handle === 'entry') { const p = yToPrice(y); if (p !== null) this.entry = snapToTick(p); }
    else if (handle === 'tp') { const p = yToPrice(y); if (p !== null) this.tp = snapToTick(p); }
    else if (handle === 'sl') { const p = yToPrice(y); if (p !== null) this.sl = snapToTick(p); }
    else if (handle === 'left') { const t = xToTime(x); if (t !== null) this.t1 = t; }
    else if (handle === 'right') { const t = xToTime(x); if (t !== null) this.t2 = t; }
    else if (handle === 'body' && this._dragOrigin) {
      const o = this._dragOrigin;
      const dx = x - o.startX, dy = y - o.startY;
      const t1 = xToTime(o.xL + dx), t2 = xToTime(o.xR + dx);
      const pe = yToPrice(o.yE + dy), pt = yToPrice(o.yTp + dy), ps = yToPrice(o.ySl + dy);
      if (t1 !== null) this.t1 = t1;
      if (t2 !== null) this.t2 = t2;
      if (pe !== null) this.entry = snapToTick(pe);
      if (pt !== null) this.tp = snapToTick(pt);
      if (ps !== null) this.sl = snapToTick(ps);
    }
    this.refresh();
  }
  endDrag() { this._dragOrigin = null; }
}

/* ============================================================
   6b. CANDLE COUNTDOWN BADGE
   ------------------------------------------------------------
   A small always-on badge showing time remaining until the current
   bar closes, positioned at the same Y as the live price so it moves
   up/down with it (Bybit-style). Not interactive, not deletable, not
   part of the user-drawn `primitives` array — attached once at
   bootstrap and left alone.
   ============================================================ */
class CandleCountdownBadge {
  constructor() {
    this._chart = null; this._series = null; this._requestUpdate = null;
    this._paneView = { renderer: () => ({ draw: (target) => this.draw(target) }) };
  }
  attached(param) { this._chart = param.chart; this._series = param.series; this._requestUpdate = param.requestUpdate; }
  detached() {}
  updateAllViews() {}
  paneViews() { return [this._paneView]; }
  refresh() { if (this._requestUpdate) this._requestUpdate(); }

  draw(target) {
    if (lastDisplayedPrice === null || !chartData.length) return;
    const y = priceToY(lastDisplayedPrice);
    if (y === null) return;

    let lastRealTime = null;
    for (let i = chartData.length - 1; i >= 0; i--) {
      if (chartData[i].open !== undefined) { lastRealTime = chartData[i].time; break; }
    }
    if (lastRealTime === null) return;

    const interval = barIntervalSeconds || 60;
    const barCloseTime = lastRealTime + interval;
    const remaining = Math.max(0, Math.round(barCloseTime - Date.now() / 1000));
    const mm = Math.floor(remaining / 60), ss = remaining % 60;
    const text = `${mm}:${String(ss).padStart(2, '0')}`;

    target.useBitmapCoordinateSpace(scope => {
      const ctx = scope.context;
      ctx.save();
      ctx.font = `${10 * scope.verticalPixelRatio}px monospace`;
      const paddingX = 5 * scope.horizontalPixelRatio;
      const h = 15 * scope.verticalPixelRatio;
      const w = ctx.measureText(text).width + paddingX * 2;
      // Series primitives drawn via paneViews() render on the main pane's own
      // canvas, which already ends exactly where the price scale begins —
      // it does NOT include that gutter, so no extra width needs subtracting.
      const xRight = scope.bitmapSize.width - 4 * scope.horizontalPixelRatio;
      const yTop = bitY(scope, y) - h - 3 * scope.verticalPixelRatio; // sit just above the native price label, same Y as the price

      ctx.fillStyle = '#1e222d';
      ctx.strokeStyle = '#e6a23c';
      ctx.lineWidth = 1 * scope.horizontalPixelRatio;
      if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(xRight - w, yTop, w, h, 3 * scope.horizontalPixelRatio); }
      else { ctx.beginPath(); ctx.rect(xRight - w, yTop, w, h); }
      ctx.fill(); ctx.stroke();

      ctx.fillStyle = '#e6a23c';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'right';
      ctx.fillText(text, xRight - paddingX, yTop + h / 2);
      ctx.textAlign = 'left';
      ctx.restore();
    });
  }
}
