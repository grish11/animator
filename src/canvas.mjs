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

import {
  normalizeColorEffect,
  strokeColorFor as sharedStrokeColor,
} from "./color_effects.mjs";

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
// See COLOR_EFFECT_MODES in color_effects.mjs
let colorEffect = "static";
let frameNow = 0; // performance.now() of the current frame (ms)
let gifWorkerUrl = null;
let gifLibPromise = null;
let exporting = false;

const TENTHS_PER_SECOND = 10;
const CANVAS_BG = "#0a0a14";
const GIF_CDN = "https://cdn.jsdelivr.net/npm/gif.js@0.2.0/dist";
const GIF_MAX_SIDE = 480;
const GIF_FRAME_COUNT = 36;
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
  colorEffect = normalizeColorEffect(mode);
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
  if (!findCanvas() || !drawing) return;
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

// ── Colour effects (primary / secondary) — see color_effects.mjs ─────────────

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

function strokeColorFor(p) {
  const n = drawing && drawing.paths ? drawing.paths.length : 1;
  return sharedStrokeColor({
    mode: colorEffect,
    index: p.index | 0,
    count: n,
    tSec: frameNow / 1000,
    mid: pathMid(p),
    primary: primaryColor,
    secondary: secondaryColor,
  });
}

// ── Export PNG / GIF ─────────────────────────────────────────────────────────
// PNG: MDN HTMLCanvasElement.toBlob → Blob → object URL download
//   https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/toBlob
// GIF: gif.js addFrame(canvas) + render() (jnordberg/gif.js README)
//   https://github.com/jnordberg/gif.js

function safeName(name, ext) {
  const base = String(name || "drawing")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return `${base || "drawing"}.${ext}`;
}

function downloadBlob(blob, filename) {
  // MDN: URL.createObjectURL + revoke when done
  // https://developer.mozilla.org/en-US/docs/Web/API/URL/createObjectURL_static
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-export-src="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded === "1") return resolve();
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error(src)));
      return;
    }
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.dataset.exportSrc = src;
    s.onload = () => {
      s.dataset.loaded = "1";
      resolve();
    };
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
}

async function loadGifLibrary() {
  if (window.GIF && gifWorkerUrl) return window.GIF;
  if (gifLibPromise) return gifLibPromise;
  gifLibPromise = (async () => {
    await loadScript(`${GIF_CDN}/gif.js`);
    if (!window.GIF) throw new Error("gif.js did not define window.GIF");
    // Same-origin worker via Blob URL (CDN workers are blocked cross-origin).
    const workerBlob = await fetch(`${GIF_CDN}/gif.worker.js`).then((r) => {
      if (!r.ok) throw new Error("Failed to fetch gif.worker.js");
      return r.blob();
    });
    gifWorkerUrl = URL.createObjectURL(workerBlob);
    return window.GIF;
  })().catch((e) => {
    gifLibPromise = null;
    throw e;
  });
  return gifLibPromise;
}

function snapshotWithBackground() {
  // GIF has weak transparency support; bake the app background in.
  const src = canvas;
  const w = src.width;
  const h = src.height;
  const scale = Math.min(1, GIF_MAX_SIDE / Math.max(w, h, 1));
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(w * scale));
  out.height = Math.max(1, Math.round(h * scale));
  const octx = out.getContext("2d");
  octx.fillStyle = CANVAS_BG;
  octx.fillRect(0, 0, out.width, out.height);
  octx.drawImage(src, 0, 0, out.width, out.height);
  return out;
}

/// Snapshot the current canvas as a PNG download (MDN toBlob, type image/png).
export function exportPng(name) {
  if (!findCanvas() || !drawing) {
    console.error("Nothing to export yet.");
    return;
  }
  render();
  // Prefer toBlob over toDataURL for large canvases (MDN guidance).
  canvas.toBlob((blob) => {
    if (!blob) {
      console.error("canvas.toBlob returned null");
      return;
    }
    downloadBlob(blob, safeName(name, "png"));
  }, "image/png");
}

/// Replay the drawing into an animated GIF and download it (gif.js API).
/// `onDone` is invoked when encoding finishes or fails (Gleam clears busy state).
export function exportGif(name, onDone) {
  const done = () => {
    if (typeof onDone === "function") onDone();
  };
  if (exporting) {
    done();
    return;
  }
  if (!findCanvas() || !drawing) {
    console.error("Nothing to export yet.");
    done();
    return;
  }
  exporting = true;
  const savedClock = clock;
  const savedRate = rate;
  rate = 0;

  const finish = () => {
    clock = savedClock;
    rate = savedRate;
    frameNow = performance.now();
    render();
    exporting = false;
    done();
  };

  loadGifLibrary()
    .then((GIF) => {
      // Fully drawn: GIF loops colour Effects on the finished piece, not the reveal.
      const end =
        Number.isFinite(drawing.endClock) && drawing.endClock > 0
          ? drawing.endClock
          : 0;
      clock = end;

      const frames = GIF_FRAME_COUNT;
      // ~2s effect loop at ~18fps (matches Wave/Cycle periods roughly).
      const loopMs = 2000;
      const delayMs = Math.round(loopMs / frames);
      const t0 = performance.now();

      // First frame sizes the GIF (gif.js README: width/height from first frame).
      frameNow = t0;
      render();
      const first = snapshotWithBackground();
      const gif = new GIF({
        workers: 2,
        quality: 10,
        workerScript: gifWorkerUrl,
        width: first.width,
        height: first.height,
        background: CANVAS_BG,
      });

      for (let i = 0; i < frames; i++) {
        // Advance wall-clock time so Wave/Cycle/Noise/Spiral animate; clock stays finished.
        frameNow = t0 + (loopMs * i) / Math.max(1, frames);
        render();
        const frameCanvas = snapshotWithBackground();
        // gif.js: addFrame(canvasElement, { delay, copy })
        gif.addFrame(frameCanvas, { delay: delayMs, copy: true });
      }

      gif.on("finished", (blob) => {
        downloadBlob(blob, safeName(name, "gif"));
        finish();
      });
      gif.on("abort", () => {
        console.error("GIF export aborted");
        finish();
      });
      gif.render();
    })
    .catch((e) => {
      console.error("GIF export failed:", e);
      finish();
    });
}

