// The canvas animation loop. The renderer is kept out of Lustre's virtual DOM:
// Gleam computes the full curve of every path once (whenever the code or
// `shape_slider` changes) and pushes it here via `setDrawing`. A single
// requestAnimationFrame loop owns the clock and, each frame, reveals a growing
// prefix of the precomputed points straight to the 2D context. So per frame
// there is no geometry work and no vdom diffing — just canvas strokes — which
// is what lets many paths animate at high frames per second.
//
// Values cross the Gleam/JS boundary directly — no JSON: a Gleam record arrives
// as an object with named fields, and a Gleam list is iterable.


let canvas = null;
let ctx = null;
// { paths: [{ pts: Float64Array [x0,y0,...], thickness, color, start, end, index }] }
let drawing = null;
let rate = 1; // a multiple of normal speed; negative plays the drawing backward
let clock = 0; // the drawing's time, in tenths of a second, in [0, endClock]
let lastTs = 0;
let running = false;
let framesWithoutCanvas = 0;
let primaryColor = "#e8d8b0";
let secondaryColor = "#8a8aca";
// "static" | "wave" | "cycle" | "noise" | "spiral"
let colorEffect = "static";
let frameNow = 0; // performance.now() of the current frame (ms)

const TENTHS_PER_SECOND = 10;
// How many frames (about 10 seconds' worth) to wait for the canvas to appear
// before reporting that it hasn't.
const MAX_FRAMES_WITHOUT_CANVAS = 600;

// Replace the drawing being animated. `pathList` is the List(RenderPath) built
// by render.gleam; each path's points are packed into a flat Float64Array so
// the per-frame draw loop touches only contiguous numbers.
export function setDrawing(pathList) {
  const paths = [];
  let index = 0;
  for (const p of pathList) {
    const flat = [];
    for (const q of p.points) flat.push(q.x, q.y);
    paths.push({
      pts: new Float64Array(flat),
      thickness: p.thickness,
      color: p.color,
      start: p.start,
      end: p.end,
      index: index++,
    });
  }
  // Keep the current clock across drawing swaps: dragging the shape slider on an
  // already-finished drawing shows the new shape complete, rather than restarting.
  // When the new drawing is longer, jump to its end so a finished piece does not
  // keep animating the extra paths; mid-animation swaps keep the same time.
  // `endClock` is the moment the last path finishes drawing, past which the frame
  // loop holds time still (see frame).
  const wasFinished =
    drawing != null && Number.isFinite(drawing.endClock) && clock >= drawing.endClock;
  drawing = { paths, endClock: drawingEndClock(paths) };
  if (wasFinished && Number.isFinite(drawing.endClock)) {
    clock = drawing.endClock;
  } else {
    clock = clamp(clock, 0, drawing.endClock);
  }
  if (!running) {
    running = true;
    lastTs = performance.now();
    requestAnimationFrame(frame);
  }
}

// The clock at which every path has fully drawn — the largest per-path finish
// time (u = 1). A path finishes at its `end` time, or right at `start` when it
// has no positive duration (end ≤ start, an instant path). An empty drawing
// has nothing to finish, so time runs on unbounded (Infinity).
function drawingEndClock(paths) {
  let end = Infinity;
  for (const p of paths) {
    const finish = Math.max(p.start, p.end);
    end = end === Infinity ? finish : Math.max(end, finish);
  }
  return end;
}

export function setSpeed(r) {
  rate = r;
}

// Jump the animation back to the start (empty canvas).
export function resetClock() {
  clock = 0;
}

export function setPalette(primary, secondary) {
  primaryColor = primary || primaryColor;
  secondaryColor = secondary || secondaryColor;
}

export function setColorEffect(mode) {
  const next = String(mode || "static").toLowerCase();
  colorEffect = ["static", "wave", "cycle", "noise", "spiral"].includes(next)
    ? next
    : "static";
}

function frame(ts) {
  // Cap dt so a backgrounded/paused tab can't jump the clock far ahead.
  const dt = Math.min((ts - lastTs) / 1000, 0.1);
  lastTs = ts;
  frameNow = ts;
  // The clock runs forward, each path drawing in over its window and then
  // staying; there is no loop back to an empty canvas. It is bounded at both
  // ends: reverse rewinds only as far as the start (0), and forward stops the
  // instant the last path has fully drawn (endClock), so time never runs on past
  // a finished drawing.
  clock += dt * rate * TENTHS_PER_SECOND;
  clock = clamp(clock, 0, drawing.endClock);
  render();
  requestAnimationFrame(frame);
}

// Match the backing store to the element's CSS size (× device pixel ratio) so
// the drawing stays crisp; only touched when the size actually changes.
function ensureSize() {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(canvas.clientWidth * dpr);
  const h = Math.round(canvas.clientHeight * dpr);
  if (w > 0 && h > 0 && (canvas.width !== w || canvas.height !== h)) {
    canvas.width = w;
    canvas.height = h;
  }
}

// Find the page's canvas, which Lustre can add to the page after the first drawing
// arrives. Returns whether it is there.
function findCanvas() {
  const el = document.getElementById("animation-canvas");
  if (!el) {
    framesWithoutCanvas += 1;
    if (framesWithoutCanvas === MAX_FRAMES_WITHOUT_CANVAS) {
      console.error('The page has no <canvas id="animation-canvas"> element to draw on.');
    }
    return false;
  }
  if (el !== canvas) {
    canvas = el;
    ctx = canvas.getContext("2d");
  }
  return true;
}

function render() {
  if (!findCanvas()) return;
  ensureSize();
  const w = canvas.width;
  const h = canvas.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  // Draw functions work in a 0..1000 world centred on the origin: scale it to
  // fill the canvas and translate (0, 0) to the middle, so positive coordinates
  // run toward the bottom-right corner.
  ctx.setTransform(w / 1000, 0, 0, h / 1000, w / 2, h / 2);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const p of drawing.paths) {
    // Each path is revealed by a parameter u ∈ [0, 1] that advances at a steady
    // rate. A path is complete once u reaches 1.
    const u = penU(p);
    // `u` clamps to 0 both before a path starts and at the very instant it
    // does, so it can't tell "not yet" from "just begun". Gate on the start
    // time instead, so a just-begun path is shown at rest at u = 0
    // rather than staying hidden until the clock advances.
    if (clock >= p.start) {
      drawUpToU(p, u);
    }
  }
}

// How much of a path is revealed now: its parameter u ∈ [0, 1], advancing
// linearly from its start time to its end time — 0 before it starts, 1 once
// done. A path with no positive duration (end ≤ start) appears complete the
// moment it starts.
function penU(p) {
  const duration = p.end - p.start;
  if (duration <= 0) return clock >= p.start ? 1 : 0;
  const u = (clock - p.start) / duration;
  return u < 0 ? 0 : u > 1 ? 1 : u;
}

function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

// Stroke the first `u` fraction of a path's polyline, interpolating the final
// partial segment so the curve reveals smoothly rather than a vertex at a time.
function drawUpToU(p, u) {
  const pts = p.pts;
  const count = pts.length / 2;
  if (count < 2) return;
  const segs = count - 1;
  const f = u * segs;
  const k = Math.min(segs, Math.floor(f));
  ctx.beginPath();
  ctx.moveTo(pts[0], pts[1]);
  for (let i = 1; i <= k; i++) ctx.lineTo(pts[2 * i], pts[2 * i + 1]);
  const frac = f - k;
  if (k < segs && frac > 0) {
    const ax = pts[2 * k];
    const ay = pts[2 * k + 1];
    const bx = pts[2 * k + 2];
    const by = pts[2 * k + 3];
    ctx.lineTo(ax + (bx - ax) * frac, ay + (by - ay) * frac);
  }
  ctx.lineWidth = p.thickness;
  ctx.strokeStyle = strokeColorFor(p);
  ctx.stroke();
}

// ── Colour effects (primary / secondary) ─────────────────────────────────────

function parseHex(hex) {
  const s = String(hex || "").replace("#", "").trim();
  if (s.length === 3) {
    return [
      parseInt(s[0] + s[0], 16),
      parseInt(s[1] + s[1], 16),
      parseInt(s[2] + s[2], 16),
    ];
  }
  if (s.length >= 6) {
    return [
      parseInt(s.slice(0, 2), 16),
      parseInt(s.slice(2, 4), 16),
      parseInt(s.slice(4, 6), 16),
    ];
  }
  return [232, 216, 176];
}

function lerpColor(a, b, t) {
  const u = clamp(t, 0, 1);
  const A = parseHex(a);
  const B = parseHex(b);
  const r = Math.round(A[0] + (B[0] - A[0]) * u);
  const g = Math.round(A[1] + (B[1] - A[1]) * u);
  const bl = Math.round(A[2] + (B[2] - A[2]) * u);
  return `rgb(${r},${g},${bl})`;
}

function pathMid(p) {
  const pts = p.pts;
  const n = pts.length / 2;
  if (n < 1) return { x: 0, y: 0 };
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += pts[2 * i];
    sy += pts[2 * i + 1];
  }
  return { x: sx / n, y: sy / n };
}

function hash01(i, tick) {
  const x = Math.sin(i * 12.9898 + tick * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

function strokeColorFor(p) {
  const i = p.index | 0;
  const n = drawing && drawing.paths ? drawing.paths.length : 1;
  const tSec = frameNow / 1000;

  switch (colorEffect) {
    case "wave": {
      // Travelling band of primary sweeping along path order; secondary fills behind.
      const phase = tSec * 1.4;
      const pos = n <= 1 ? 0 : i / (n - 1);
      const wave = Math.sin(pos * Math.PI * 2 - phase);
      return lerpColor(primaryColor, secondaryColor, (wave + 1) / 2);
    }
    case "cycle": {
      // Global breathe: primary fades into secondary and back.
      const breath = (Math.sin(tSec * 1.6) + 1) / 2;
      return lerpColor(primaryColor, secondaryColor, breath);
    }
    case "noise": {
      // Per-path flicker between the two colours.
      const tick = Math.floor(tSec * 6);
      const a = hash01(i, tick);
      const b = hash01(i, tick + 1);
      const frac = tSec * 6 - tick;
      const mixed = a * (1 - frac) + b * frac;
      return lerpColor(primaryColor, secondaryColor, mixed);
    }
    case "spiral": {
      // Colours rotate around the origin by path angle and radius.
      const mid = pathMid(p);
      const ang = Math.atan2(mid.y, mid.x);
      const rad = Math.hypot(mid.x, mid.y) / 500;
      const swirl = Math.sin(ang * 3 - tSec * 2.2 + rad * 5);
      return lerpColor(primaryColor, secondaryColor, (swirl + 1) / 2);
    }
    case "static":
    default:
      return i % 2 === 0 ? primaryColor : secondaryColor;
  }
}

