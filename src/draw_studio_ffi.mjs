// Draw Studio ink engine.
//
// Pipeline (research-backed):
// 1. Pointer capture — MDN setPointerCapture
//    https://developer.mozilla.org/en-US/docs/Web/API/Element/setPointerCapture
// 2. Coalesced samples — MDN getCoalescedEvents
//    https://developer.mozilla.org/en-US/docs/Web/API/PointerEvent/getCoalescedEvents
// 3. Live One-Euro filter (preview only) — Casiez et al. / stroke-stabilizer
//    https://github.com/usapopopooon/stroke-stabilizer
// 4. Arc-length resample before simplify — $1 recognizer (Wobbrock et al. UIST 2007)
//    https://faculty.washington.edu/wobbrock/pubs/uist-07.01.pdf
// 5. RDP simplify on commit — Ramer–Douglas–Peucker (keep over Visvalingam for cusps)
//    https://martinfleischmann.net/line-simplification-algorithms/
// 6. Collinear merge before integer round — Turf cleanCoords idea
//    https://turfjs.org/docs/api/cleanCoords
// 7. CSS→world mapping via getBoundingClientRect (not buffer pixels)
//    https://developer.mozilla.org/en-US/docs/Web/API/Element/getBoundingClientRect
// 8. Pressure → Path thickness — MDN PointerEvent.pressure + perfect-freehand speed fallback
//    https://developer.mozilla.org/en-US/docs/Web/API/PointerEvent/pressure
//    https://github.com/steveruizok/perfect-freehand
//
// Code emission uses Path(Line(...)) ints so the existing evaluator/renderer work.

import {
  normalizeColorEffect,
  strokeColorFor as sharedStrokeColor,
} from "./color_effects.mjs";

const BG = "#0a0a14";
const WORLD = 1000;

let root = null;
let canvas = null;
let ctx = null;
let boundCanvas = null;
let running = false;
/** @type {{ points: {x:number,y:number}[], widths: number[] }[]} */
let strokes = [];
let liveRaw = null; // [{x,y,p,t}]
let liveSmooth = null;
let pointerId = null;
let fidelity = 1; // 0 low, 1 med, 2 high
let primary = "#e8d8b0";
let secondary = "#8a8aca";
let colorEffect = "static";
let onCode = null;
let frameNow = 0;
let oneEuroX = null;
let oneEuroY = null;
let tool = "pen"; // "pen" | "eraser"
let gridSize = 0; // 0 off, else world units
let autoClose = true;
let mirrorH = false;
let pressureEnabled = true;
let eraseRadius = 18; // world units; user-adjustable
let eraseCursor = null; // {x,y} brush preview while eraser is active

// World-space params (canvas is a 1000-unit square in paint space).
const FIDELITY_SPACING = [3.0, 2.0, 1.25];
const FIDELITY_EPS = [6.0, 3.0, 1.5];
const MIN_DIST = 1.0;
const CORNER_DOT = -0.707; // cos(45°); sharper turns are locked
const COLLINEAR_TOL = 0.75;
const CLOSE_THRESH = 16;
const CLOSE_MIN_LEN = 64;
const DEFAULT_WIDTH = 3;

// ── One-Euro filter (Casiez, Roussel, Vogel) ─────────────────────────────────

export function oneEuroCreate(minCutoff = 1.2, beta = 0.007, dCutoff = 1.0) {
  return {
    minCutoff,
    beta,
    dCutoff,
    x: null,
    dx: 0,
    t: null,
  };
}

function euroAlpha(cutoff, dt) {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / Math.max(dt, 1e-6));
}

export function oneEuroFilter(state, value, tMs) {
  const t = tMs / 1000;
  if (state.x == null || state.t == null) {
    state.x = value;
    state.dx = 0;
    state.t = t;
    return value;
  }
  const dt = Math.max(t - state.t, 1e-6);
  const dValue = (value - state.x) / dt;
  const aD = euroAlpha(state.dCutoff, dt);
  state.dx = aD * dValue + (1 - aD) * state.dx;
  const cutoff = state.minCutoff + state.beta * Math.abs(state.dx);
  const a = euroAlpha(cutoff, dt);
  state.x = a * value + (1 - a) * state.x;
  state.t = t;
  return state.x;
}

// ── Geometry helpers ─────────────────────────────────────────────────────────

export function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function pointLineDist(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1e-9;
  return Math.abs(dy * (p.x - a.x) - dx * (p.y - a.y)) / len;
}

/** Shortest distance from point to finite segment AB (clamped projection). */
export function pointSegmentDist(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return dist(p, a);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return dist(p, { x: a.x + t * dx, y: a.y + t * dy });
}

export function snapToGrid(p, grid) {
  const g = Number(grid) || 0;
  if (g <= 0) return { x: p.x, y: p.y };
  return {
    x: Math.round(p.x / g) * g,
    y: Math.round(p.y / g) * g,
  };
}

/** Arc-length resample — $1 recognizer style fixed spacing. */
export function resamplePolyline(points, spacing) {
  const s = Math.max(0.5, Number(spacing) || 2);
  if (!points || points.length < 2) return (points || []).map((p) => ({ ...p }));
  const out = [{ ...points[0] }];
  let carry = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    let segLen = dist(a, b);
    if (segLen < 1e-9) continue;
    let from = a;
    while (carry + segLen >= s) {
      const t = (s - carry) / segLen;
      const nx = from.x + (b.x - from.x) * t;
      const ny = from.y + (b.y - from.y) * t;
      const np = {
        x: nx,
        y: ny,
        p: lerpNum(from.p, b.p, t),
        t: lerpNum(from.t, b.t, t),
      };
      out.push(np);
      from = np;
      segLen = dist(from, b);
      carry = 0;
    }
    carry += segLen;
  }
  const last = points[points.length - 1];
  const tail = out[out.length - 1];
  if (!tail || dist(tail, last) > 1e-6) out.push({ ...last });
  return out;
}

function lerpNum(a, b, t) {
  const A = a == null ? 0.5 : a;
  const B = b == null ? 0.5 : b;
  return A + (B - A) * t;
}

/** Iterative Ramer–Douglas–Peucker with forced keep indices (corners). */
export function rdp(points, eps, forceKeep) {
  const n = points.length;
  if (n < 3) return points.slice();
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  if (forceKeep) {
    for (const i of forceKeep) {
      if (i > 0 && i < n - 1) keep[i] = 1;
    }
  }
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let maxD = 0;
    let maxI = -1;
    const A = points[a];
    const B = points[b];
    for (let i = a + 1; i < b; i++) {
      const d = pointLineDist(points[i], A, B);
      if (d > maxD) {
        maxD = d;
        maxI = i;
      }
    }
    if (maxD > eps && maxI >= 0) {
      keep[maxI] = 1;
      stack.push([a, maxI], [maxI, b]);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i]);
  return out;
}

/** Mark sharp corners so RDP cannot delete them. */
export function cornerIndices(points) {
  const idx = [];
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1];
    const b = points[i];
    const c = points[i + 1];
    const v1x = b.x - a.x;
    const v1y = b.y - a.y;
    const v2x = c.x - b.x;
    const v2y = c.y - b.y;
    const n1 = Math.hypot(v1x, v1y) || 1e-9;
    const n2 = Math.hypot(v2x, v2y) || 1e-9;
    const dot = (v1x * v2x + v1y * v2y) / (n1 * n2);
    if (dot < CORNER_DOT) idx.push(i);
  }
  return idx;
}

/** Drop near-collinear vertices (pre- and post-round). */
export function mergeCollinear(points, tol = COLLINEAR_TOL) {
  if (!points || points.length < 3) return (points || []).slice();
  const out = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const a = out[out.length - 1];
    const b = points[i];
    const c = points[i + 1];
    if (pointLineDist(b, a, c) > tol) out.push(b);
  }
  out.push(points[points.length - 1]);
  return out;
}

export function closeStrokeIfNear(points, thresh = CLOSE_THRESH) {
  if (!points || points.length < 3) return (points || []).slice();
  let len = 0;
  for (let i = 1; i < points.length; i++) len += dist(points[i - 1], points[i]);
  if (len < CLOSE_MIN_LEN) return points.slice();
  const first = points[0];
  const last = points[points.length - 1];
  if (dist(first, last) > thresh) return points.slice();
  const out = points.slice();
  out[out.length - 1] = { ...first, p: last.p, t: last.t };
  return out;
}

function roundPt(p) {
  return { x: Math.round(p.x), y: Math.round(p.y), p: p.p, t: p.t };
}

function dedupeRounded(points) {
  const out = [];
  for (const p of points) {
    const r = roundPt(p);
    const last = out[out.length - 1];
    if (!last || last.x !== r.x || last.y !== r.y) out.push(r);
  }
  return out;
}

/**
 * Full commit pipeline.
 * @param {Array<{x:number,y:number,p?:number,t?:number}>} raw
 * @param {{ fidelity?: number, grid?: number, autoClose?: boolean }} [options]
 */
export function simplifyStroke(raw, options = {}) {
  const level = options.fidelity != null ? options.fidelity : fidelity;
  const grid = options.grid != null ? options.grid : gridSize;
  const doClose = options.autoClose != null ? options.autoClose : autoClose;
  if (!raw || raw.length < 2) return (raw || []).map(roundPt);

  const spacing = FIDELITY_SPACING[level] ?? 2;
  const eps = FIDELITY_EPS[level] ?? 3;
  let pts = resamplePolyline(raw, spacing);
  if (doClose) pts = closeStrokeIfNear(pts, CLOSE_THRESH);
  const corners = cornerIndices(pts);
  pts = rdp(pts, eps, corners);
  pts = mergeCollinear(pts, COLLINEAR_TOL);
  pts = dedupeRounded(pts);
  if (grid > 0) {
    pts = pts.map((p) => {
      const s = snapToGrid(p, grid);
      return { ...p, x: s.x, y: s.y };
    });
    pts = dedupeRounded(pts);
  }
  pts = mergeCollinear(pts, 0); // exact lattice collinear
  if (pts.length === 1) pts.push({ x: pts[0].x + 1, y: pts[0].y, p: pts[0].p });
  return pts;
}

function pressureToWidth(pAvg, speedHint) {
  if (!pressureEnabled) return DEFAULT_WIDTH;
  let p = pAvg;
  if (p == null || p <= 0 || Math.abs(p - 0.5) < 1e-6) {
    // Mouse reports 0.5; simulate from speed (perfect-freehand idea).
    const spacing = FIDELITY_SPACING[fidelity] ?? 2;
    p = Math.min(1, Math.max(0.15, 1 - (speedHint || 0) / (2.5 * spacing)));
  }
  return Math.max(2, Math.min(16, Math.round(8 * (0.45 + 0.55 * p))));
}

function widthsForPoints(points) {
  const widths = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const pAvg = ((a.p ?? 0.5) + (b.p ?? 0.5)) / 2;
    const speed = dist(a, b);
    widths.push(pressureToWidth(pAvg, speed));
  }
  return widths;
}

function mirrorStroke(stroke) {
  const points = stroke.points.map((p) => ({ ...p, x: -p.x }));
  return { points, widths: (stroke.widths || []).slice() };
}

/**
 * Eraser: drop segments within radius; keep leftover polylines.
 * Uses clamped point–segment distance so long chords erase locally
 * (Inkscape-style cut) instead of deleting whole strokes.
 */
export function eraseNearStrokes(strokeList, point, radius = 18) {
  const R = Math.max(1, radius);
  const next = [];
  for (const stroke of strokeList) {
    const pts = stroke.points;
    const widths = stroke.widths || [];
    let chunk = [];
    let chunkW = [];
    const flush = () => {
      if (chunk.length >= 2) {
        next.push({ points: chunk, widths: chunkW });
      }
      chunk = [];
      chunkW = [];
    };
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const halfW = (widths[i] != null ? widths[i] : DEFAULT_WIDTH) / 2;
      const hit = pointSegmentDist(point, a, b) <= R + halfW;
      if (hit) {
        flush();
      } else {
        if (!chunk.length) chunk.push(a);
        chunk.push(b);
        chunkW.push(widths[i] != null ? widths[i] : DEFAULT_WIDTH);
      }
    }
    flush();
  }
  return next;
}

// ── Code generation ──────────────────────────────────────────────────────────

export function strokesToGleam(strokeList) {
  const list = strokeList || strokes;
  if (!list.length) {
    return `fn draw(shape_slider: Int) -> List(Path) {
  []
}
`;
  }
  const paths = [];
  let t = 0;
  for (const stroke of list) {
    const pts = stroke.points;
    const widths = stroke.widths || [];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const w = widths[i] != null ? widths[i] : DEFAULT_WIDTH;
      paths.push(
        `    Path(Line(Point(${a.x}, ${a.y}), Point(${b.x}, ${b.y})), ${t}, ${t + 2}, ${w}),`,
      );
      t += 2;
    }
  }
  return `fn draw(shape_slider: Int) -> List(Path) {
  [
${paths.join("\n")}
  ]
}
`;
}

function emitCode() {
  if (typeof onCode === "function") onCode(strokesToGleam(strokes));
}

// ── Rendering ────────────────────────────────────────────────────────────────

function clientToWorld(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const cssX = clientX - rect.left;
  const cssY = clientY - rect.top;
  const x = (cssX / Math.max(rect.width, 1)) * WORLD - WORLD / 2;
  const y = (cssY / Math.max(rect.height, 1)) * WORLD - WORLD / 2;
  return { x, y };
}

function ensureSize() {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(canvas.clientWidth * dpr);
  const h = Math.round(canvas.clientHeight * dpr);
  if (w > 0 && h > 0 && (canvas.width !== w || canvas.height !== h)) {
    canvas.width = w;
    canvas.height = h;
  }
}

function strokeColor(index, mid) {
  return sharedStrokeColor({
    mode: colorEffect,
    index,
    count: Math.max(1, totalSegments()),
    tSec: frameNow / 1000,
    mid,
    primary,
    secondary,
  });
}

function totalSegments() {
  let n = 0;
  for (const s of strokes) n += Math.max(0, s.points.length - 1);
  if (liveSmooth && liveSmooth.length > 1) n += liveSmooth.length - 1;
  return n;
}

function drawPolyline(pts, color, width) {
  if (!pts || pts.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.stroke();
}

function paintGrid() {
  if (!gridSize || gridSize <= 0) return;
  const g = gridSize;
  ctx.strokeStyle = "rgba(70,70,110,0.28)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = -WORLD / 2; x <= WORLD / 2; x += g) {
    ctx.moveTo(x, -WORLD / 2);
    ctx.lineTo(x, WORLD / 2);
  }
  for (let y = -WORLD / 2; y <= WORLD / 2; y += g) {
    ctx.moveTo(-WORLD / 2, y);
    ctx.lineTo(WORLD / 2, y);
  }
  ctx.stroke();
}

function ensureCanvasBound() {
  const el = document.getElementById("draw-studio-canvas");
  if (!el) return false;
  if (el !== canvas || el !== boundCanvas) {
    canvas = el;
    ctx = canvas.getContext("2d");
    if (boundCanvas && boundCanvas !== canvas) {
      boundCanvas.removeEventListener("pointerdown", onPointerDown);
      boundCanvas.removeEventListener("pointermove", onPointerMove);
      boundCanvas.removeEventListener("pointerup", onPointerUp);
      boundCanvas.removeEventListener("pointercancel", onPointerUp);
    }
    if (boundCanvas !== canvas) {
      boundCanvas = canvas;
      canvas.addEventListener("pointerdown", onPointerDown);
      canvas.addEventListener("pointermove", onPointerMove);
      canvas.addEventListener("pointerup", onPointerUp);
      canvas.addEventListener("pointercancel", onPointerUp);
      canvas.addEventListener("pointerleave", onPointerLeave);
      canvas.style.touchAction = "none";
      canvas.style.cursor = tool === "eraser" ? "none" : "crosshair";
    }
  }
  return true;
}

function paint() {
  if (!ensureCanvasBound() || !ctx || !canvas) return;
  ensureSize();
  const w = canvas.width;
  const h = canvas.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, w, h);
  ctx.setTransform(w / WORLD, 0, 0, h / WORLD, w / 2, h / 2);

  paintGrid();

  let seg = 0;
  for (const stroke of strokes) {
    const pts = stroke.points;
    const widths = stroke.widths || [];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const ww = widths[i] != null ? widths[i] : DEFAULT_WIDTH;
      drawPolyline([a, b], strokeColor(seg++, mid), ww);
    }
  }
  if (tool === "pen" && liveSmooth && liveSmooth.length >= 2) {
    drawPolyline(liveSmooth, primary, 3.5);
  } else if (tool === "pen" && liveRaw && liveRaw.length >= 2) {
    drawPolyline(liveRaw, primary, 3.5);
  }

  ctx.strokeStyle = "rgba(80,80,120,0.35)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(-WORLD / 2, 0);
  ctx.lineTo(WORLD / 2, 0);
  ctx.moveTo(0, -WORLD / 2);
  ctx.lineTo(0, WORLD / 2);
  ctx.stroke();

  // Eraser brush preview (world-space circle).
  if (tool === "eraser" && eraseCursor) {
    ctx.beginPath();
    ctx.arc(eraseCursor.x, eraseCursor.y, eraseRadius, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(232, 120, 120, 0.85)";
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "rgba(232, 120, 120, 0.12)";
    ctx.fill();
  }
}

function frame(ts) {
  if (!running) return;
  frameNow = ts;
  paint();
  requestAnimationFrame(frame);
}

// ── Pointer handlers ─────────────────────────────────────────────────────────

function samplePressure(ev) {
  if (typeof ev.pressure === "number" && ev.pressure > 0) return ev.pressure;
  return 0.5;
}

function pushSample(ev) {
  const raw = clientToWorld(ev.clientX, ev.clientY);
  raw.p = samplePressure(ev);
  raw.t = ev.timeStamp || performance.now();
  if (!liveRaw.length) {
    liveRaw.push(raw);
    oneEuroX = oneEuroCreate();
    oneEuroY = oneEuroCreate();
    liveSmooth = [
      {
        x: oneEuroFilter(oneEuroX, raw.x, raw.t),
        y: oneEuroFilter(oneEuroY, raw.y, raw.t),
        p: raw.p,
        t: raw.t,
      },
    ];
    return;
  }
  const last = liveRaw[liveRaw.length - 1];
  if (dist(raw, last) < MIN_DIST) return;
  liveRaw.push(raw);
  liveSmooth.push({
    x: oneEuroFilter(oneEuroX, raw.x, raw.t),
    y: oneEuroFilter(oneEuroY, raw.y, raw.t),
    p: raw.p,
    t: raw.t,
  });
}

function coalescedSamples(e) {
  if (typeof e.getCoalescedEvents === "function") {
    try {
      const list = e.getCoalescedEvents();
      if (list && list.length) return list;
    } catch (_err) {
      /* ignore */
    }
  }
  return [e];
}

function eraseAtEvent(e) {
  const p = clientToWorld(e.clientX, e.clientY);
  eraseCursor = p;
  const before = strokes.length;
  const beforeSegs = strokes.reduce(
    (n, s) => n + Math.max(0, s.points.length - 1),
    0,
  );
  strokes = eraseNearStrokes(strokes, p, eraseRadius);
  const afterSegs = strokes.reduce(
    (n, s) => n + Math.max(0, s.points.length - 1),
    0,
  );
  if (strokes.length !== before || afterSegs !== beforeSegs) emitCode();
}

function onPointerDown(e) {
  if (e.button !== 0) return;
  e.preventDefault();
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch (_err) {
    /* synthetic / already captured */
  }
  pointerId = e.pointerId;
  if (tool === "eraser") {
    for (const s of coalescedSamples(e)) eraseAtEvent(s);
    return;
  }
  liveRaw = [];
  liveSmooth = [];
  oneEuroX = oneEuroCreate();
  oneEuroY = oneEuroCreate();
  for (const s of coalescedSamples(e)) pushSample(s);
}

function onPointerMove(e) {
  if (tool === "eraser") {
    eraseCursor = clientToWorld(e.clientX, e.clientY);
    if (pointerId == null || e.pointerId !== pointerId) return;
    e.preventDefault();
    for (const s of coalescedSamples(e)) eraseAtEvent(s);
    return;
  }
  if (pointerId == null || e.pointerId !== pointerId) return;
  e.preventDefault();
  for (const s of coalescedSamples(e)) pushSample(s);
}

function onPointerUp(e) {
  if (pointerId == null || e.pointerId !== pointerId) return;
  if (tool === "pen") {
    for (const s of coalescedSamples(e)) pushSample(s);
    commitStroke();
  }
  try {
    canvas.releasePointerCapture(e.pointerId);
  } catch (_err) {
    /* already released */
  }
  pointerId = null;
}

function onPointerLeave(_e) {
  if (tool === "eraser" && pointerId == null) eraseCursor = null;
}

function commitStroke() {
  const raw = liveRaw && liveRaw.length ? liveRaw : liveSmooth;
  liveRaw = null;
  liveSmooth = null;
  oneEuroX = null;
  oneEuroY = null;
  if (!raw || raw.length < 2) return;
  const points = simplifyStroke(raw, {
    fidelity,
    grid: gridSize,
    autoClose,
  });
  const stroke = { points, widths: widthsForPoints(points) };
  strokes.push(stroke);
  if (mirrorH) strokes.push(mirrorStroke(stroke));
  emitCode();
}

// ── Public API ───────────────────────────────────────────────────────────────

export function mountDrawStudio(onCodeChange) {
  onCode = onCodeChange;
  strokes = [];
  liveRaw = null;
  liveSmooth = null;
  pointerId = null;

  const tryMount = () => {
    root = document.getElementById("draw-studio-root");
    canvas = document.getElementById("draw-studio-canvas");
    if (!canvas) {
      requestAnimationFrame(tryMount);
      return;
    }
    ctx = canvas.getContext("2d");
    // Lustre may replace the <canvas> node on re-render — rebind when it changes.
    if (boundCanvas !== canvas) {
      if (boundCanvas) {
        boundCanvas.removeEventListener("pointerdown", onPointerDown);
        boundCanvas.removeEventListener("pointermove", onPointerMove);
        boundCanvas.removeEventListener("pointerup", onPointerUp);
        boundCanvas.removeEventListener("pointercancel", onPointerUp);
        boundCanvas.removeEventListener("pointerleave", onPointerLeave);
      }
      boundCanvas = canvas;
      canvas.addEventListener("pointerdown", onPointerDown);
      canvas.addEventListener("pointermove", onPointerMove);
      canvas.addEventListener("pointerup", onPointerUp);
      canvas.addEventListener("pointercancel", onPointerUp);
      canvas.addEventListener("pointerleave", onPointerLeave);
    }
    canvas.style.touchAction = "none";
    canvas.style.cursor = tool === "eraser" ? "none" : "crosshair";
    if (!running) {
      running = true;
      requestAnimationFrame(frame);
    }
    emitCode();
    paint();
  };
  tryMount();
}

export function unmountDrawStudio() {
  onCode = null;
  liveRaw = null;
  liveSmooth = null;
  pointerId = null;
  if (!document.getElementById("draw-studio-canvas")) {
    running = false;
    canvas = null;
    ctx = null;
  }
}

export function setStudioPalette(p, s) {
  primary = p || primary;
  secondary = s || secondary;
}

export function setStudioEffect(mode) {
  colorEffect = normalizeColorEffect(mode);
}

export function setStudioFidelity(level) {
  fidelity = Math.max(0, Math.min(2, level | 0));
}

export function setStudioTool(mode) {
  tool = String(mode || "pen").toLowerCase() === "eraser" ? "eraser" : "pen";
  if (tool !== "eraser") eraseCursor = null;
  if (canvas) {
    canvas.style.cursor = tool === "eraser" ? "none" : "crosshair";
  }
}

export function setStudioEraseRadius(radius) {
  eraseRadius = Math.max(4, Math.min(80, Number(radius) || 18));
}

export function setStudioGrid(size) {
  gridSize = Math.max(0, Number(size) || 0);
}

export function setStudioAutoClose(on) {
  autoClose = !!on;
}

export function setStudioMirror(on) {
  mirrorH = !!on;
}

export function setStudioPressure(on) {
  pressureEnabled = !!on;
}

export function undoStudioStroke() {
  strokes.pop();
  emitCode();
}

export function clearStudioStrokes() {
  strokes = [];
  liveRaw = null;
  liveSmooth = null;
  emitCode();
}

export function getStudioCode() {
  return strokesToGleam(strokes);
}

/** PNG of the studio canvas — MDN HTMLCanvasElement.toBlob */
export function exportStudioPng(name) {
  if (!canvas) return;
  paint();
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${String(name || "sketch").replace(/[^\w-]+/g, "_")}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }, "image/png");
}
