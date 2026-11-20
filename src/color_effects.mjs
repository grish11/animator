// Shared stroke colour Effects for the main canvas and Draw Studio.
// Inspired by livedesign animations, MetaMapper fills/edges, Synthlucida brushes,
// Neon Line Drawer, and Sparkle (aurora / pulse / shimmer).
//
// https://www.livedesign.app/help/canvas/animations/
// https://www.metamoind.com/metamapper
// https://synthlucida.com/draw.html
// https://sparkle.graphics/

export const COLOR_EFFECT_MODES = [
  "static",
  "wave",
  "cycle",
  "noise",
  "spiral",
  "pulse",
  "rainbow",
  "strobe",
  "aurora",
  "chase",
  "ripple",
  "scan",
  "flicker",
  "twinkle",
  "shimmer",
];

export function normalizeColorEffect(mode) {
  const next = String(mode || "static").toLowerCase();
  return COLOR_EFFECT_MODES.includes(next) ? next : "static";
}

function clamp01(t) {
  return Math.min(1, Math.max(0, t));
}

function parseHex(hex) {
  const s = String(hex || "").replace("#", "");
  if (s.length >= 6) {
    return [
      parseInt(s.slice(0, 2), 16),
      parseInt(s.slice(2, 4), 16),
      parseInt(s.slice(4, 6), 16),
    ];
  }
  return [232, 216, 176];
}

function lerpRgb(A, B, t) {
  const u = clamp01(t);
  return [
    Math.round(A[0] + (B[0] - A[0]) * u),
    Math.round(A[1] + (B[1] - A[1]) * u),
    Math.round(A[2] + (B[2] - A[2]) * u),
  ];
}

export function lerpColor(a, b, t) {
  return rgbString(lerpRgb(parseHex(a), parseHex(b), t));
}

function hash01(i, tick) {
  const x = Math.sin(i * 12.9898 + tick * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

function rgbToHsl(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h * 360, s, l];
}

function hslToRgb(h, s, l) {
  const H = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((H / 60) % 2) - 1));
  const m = l - c / 2;
  let rp = 0;
  let gp = 0;
  let bp = 0;
  if (H < 60) [rp, gp, bp] = [c, x, 0];
  else if (H < 120) [rp, gp, bp] = [x, c, 0];
  else if (H < 180) [rp, gp, bp] = [0, c, x];
  else if (H < 240) [rp, gp, bp] = [0, x, c];
  else if (H < 300) [rp, gp, bp] = [x, 0, c];
  else [rp, gp, bp] = [c, 0, x];
  return [
    Math.round((rp + m) * 255),
    Math.round((gp + m) * 255),
    Math.round((bp + m) * 255),
  ];
}

function rgbString(rgb) {
  return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
}

/** Heartbeat envelope: two quick peaks per period (livedesign Heartbeat). */
function heartbeat(t) {
  const u = ((t % 1) + 1) % 1;
  if (u < 0.12) return Math.sin((u / 0.12) * Math.PI);
  if (u < 0.28) return 0.55 * Math.sin(((u - 0.12) / 0.16) * Math.PI);
  return 0;
}

/**
 * @param {{
 *   mode: string,
 *   index: number,
 *   count: number,
 *   tSec: number,
 *   mid: {x:number,y:number},
 *   primary: string,
 *   secondary: string,
 * }} args
 */
export function strokeColorFor(args) {
  const mode = normalizeColorEffect(args.mode);
  const i = args.index | 0;
  const n = Math.max(1, args.count | 0);
  const tSec = args.tSec || 0;
  const mid = args.mid || { x: 0, y: 0 };
  const primary = args.primary;
  const secondary = args.secondary;
  const pos = n <= 1 ? 0 : i / (n - 1);

  switch (mode) {
    case "wave": {
      const wave = Math.sin(pos * Math.PI * 2 - tSec * 1.4);
      return lerpColor(primary, secondary, (wave + 1) / 2);
    }
    case "cycle": {
      const breath = (Math.sin(tSec * 1.6) + 1) / 2;
      return lerpColor(primary, secondary, breath);
    }
    case "noise": {
      const tick = Math.floor(tSec * 6);
      const a = hash01(i, tick);
      const b = hash01(i, tick + 1);
      const frac = tSec * 6 - tick;
      return lerpColor(primary, secondary, a * (1 - frac) + b * frac);
    }
    case "spiral": {
      const ang = Math.atan2(mid.y, mid.x);
      const rad = Math.hypot(mid.x, mid.y) / 500;
      const swirl = Math.sin(ang * 3 - tSec * 2.2 + rad * 5);
      return lerpColor(primary, secondary, (swirl + 1) / 2);
    }
    case "pulse": {
      // Double-pump heartbeat between palette colours.
      const beat = heartbeat(tSec * 1.15);
      return lerpColor(primary, secondary, beat);
    }
    case "rainbow": {
      // Spectrum chase tinted by the palette (Neon / livedesign Rainbow).
      const A = parseHex(primary);
      const B = parseHex(secondary);
      const [, sA, lA] = rgbToHsl(A[0], A[1], A[2]);
      const [, sB, lB] = rgbToHsl(B[0], B[1], B[2]);
      const hue = (i * 19 + tSec * 90) % 360;
      const sat = 0.55 + 0.35 * ((sA + sB) / 2);
      const lit = 0.42 + 0.25 * ((lA + lB) / 2);
      return rgbString(hslToRgb(hue, sat, lit));
    }
    case "strobe": {
      // Hard on/off blink (MetaMapper / livedesign Strobe).
      return Math.floor(tSec * 8) % 2 === 0 ? primary : secondary;
    }
    case "aurora": {
      // Northern-lights sway: multi-phase bands (Synthlucida / Sparkle Aurora).
      const band =
        0.5 +
        0.5 *
          Math.sin(pos * Math.PI * 3 + tSec * 0.9) *
          Math.cos(mid.y / 180 - tSec * 0.7);
      const A = lerpRgb(parseHex(primary), parseHex(secondary), clamp01(band));
      // Bias green/cyan/violet like aurora curtains.
      const g = Math.min(
        255,
        Math.round(A[1] * 0.75 + 90 * (0.5 + 0.5 * Math.sin(tSec + pos * 4))),
      );
      const b = Math.min(
        255,
        Math.round(
          A[2] * 0.7 + 110 * (0.5 + 0.5 * Math.cos(tSec * 1.3 - pos * 3)),
        ),
      );
      return `rgb(${A[0]},${g},${b})`;
    }
    case "chase": {
      // Comet / chasing pulse along path order (MetaMapper Chasing Pulse).
      const head = ((tSec * 0.55) % 1 + 1) % 1;
      const d = Math.abs(pos - head);
      const wrap = Math.min(d, 1 - d);
      const glow = Math.exp(-wrap * wrap * 70);
      return lerpColor(secondary, primary, glow);
    }
    case "ripple": {
      // Concentric ripples from the origin (Sparkle Pulse Grid / MetaMapper Ripple).
      const rad = Math.hypot(mid.x, mid.y) / 500;
      const rip = Math.sin(rad * 14 - tSec * 3.2);
      return lerpColor(primary, secondary, (rip + 1) / 2);
    }
    case "scan": {
      // Horizontal scanline sweep (MetaMapper Scan Lines).
      const yNorm = (mid.y + 500) / 1000;
      const beam = ((tSec * 0.4) % 1 + 1) % 1;
      const d = Math.abs(yNorm - beam);
      const hit = Math.exp(-d * d * 120);
      return lerpColor(secondary, primary, hit);
    }
    case "flicker": {
      // Neon stutter (livedesign Flicker).
      const tick = Math.floor(tSec * 18);
      const on = hash01(i, tick) > 0.28;
      const wobble = hash01(i + 3, tick) * 0.35;
      return on ? lerpColor(primary, secondary, wobble) : secondary;
    }
    case "twinkle": {
      // Sparse sparkles (Synthlucida Twinkle / Sparkle Fireflies).
      const tick = Math.floor(tSec * 4);
      const spark = hash01(i, tick);
      if (spark > 0.92) return primary;
      if (spark > 0.78) return lerpColor(primary, secondary, 0.35);
      return secondary;
    }
    case "shimmer": {
      // Quick glint band drifting along the drawing (livedesign Shimmer).
      const band = Math.sin(pos * Math.PI * 6 - tSec * 5.5);
      const glint = Math.pow(Math.max(0, band), 8);
      return lerpColor(secondary, primary, 0.25 + 0.75 * glint);
    }
    case "static":
    default:
      return i % 2 === 0 ? primary : secondary;
  }
}
