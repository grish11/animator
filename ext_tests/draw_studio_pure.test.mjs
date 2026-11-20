import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  rdp,
  cornerIndices,
  pointLineDist,
  pointSegmentDist,
  resamplePolyline,
  mergeCollinear,
  simplifyStroke,
  oneEuroCreate,
  oneEuroFilter,
  strokesToGleam,
  eraseNearStrokes,
  snapToGrid,
  closeStrokeIfNear,
} from "../build/dev/javascript/animator/draw_studio_ffi.mjs";

const pt = (x, y) => ({ x, y });

function segLengths(points) {
  const lens = [];
  for (let i = 1; i < points.length; i++) {
    lens.push(Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
  }
  return lens;
}

function hasEndpointPair(out, a, b) {
  return out.some(
    (p, i) =>
      i > 0 &&
      Math.hypot(p.x - a.x, p.y - a.y) < 1e-6 &&
      Math.hypot(out[i - 1].x - b.x, out[i - 1].y - b.y) < 1e-6,
  );
}

describe("strokesToGleam", () => {
  test("empty stroke list emits stub draw fn with empty list", () => {
    const code = strokesToGleam([]);
    assert.match(code, /fn draw\(shape_slider: Int\) -> List\(Path\)/);
    assert.match(code, /\[\s*\]/);
  });

  test("emits Path(Line(Point(...), Point(...), start, end, thickness)", () => {
    const strokes = [{ points: [pt(0, 0), pt(10, 0), pt(10, 10)] }];
    const code = strokesToGleam(strokes);
    assert.match(code, /Path\(Line\(Point\(0, 0\), Point\(10, 0\)\), 0, 2, 3\)/);
    assert.match(code, /Path\(Line\(Point\(10, 0\), Point\(10, 10\)\), 2, 4, 3\)/);
  });

  test("uses per-point width for Path thickness when present", () => {
    const strokes = [
      {
        points: [
          { x: 0, y: 0, width: 2.5 },
          { x: 5, y: 0, width: 4 },
        ],
      },
    ];
    const code = strokesToGleam(strokes);
    assert.match(code, /Path\(Line\(Point\(0, 0\), Point\(5, 0\)\), 0, 2, /);
    const m = code.match(/Path\(Line\(Point\(0, 0\), Point\(5, 0\)\), 0, 2, ([\d.]+)\)/);
    assert.ok(m, "expected thickness in Path");
    const thick = Number(m[1]);
    assert.ok(thick >= 2 && thick <= 5, `thickness ${thick} should reflect widths`);
  });
});

describe("pointLineDist", () => {
  test("perpendicular distance to horizontal segment", () => {
    const d = pointLineDist(pt(5, 3), pt(0, 0), pt(10, 0));
    assert.ok(Math.abs(d - 3) < 1e-9);
  });
});

describe("pointSegmentDist", () => {
  test("clamps to nearest endpoint past the segment", () => {
    // Infinite-line distance would be 0; segment distance is to (0,0).
    const d = pointSegmentDist(pt(-10, 0), pt(0, 0), pt(10, 0));
    assert.ok(Math.abs(d - 10) < 1e-9);
  });

  test("measures perpendicular hit on the segment interior", () => {
    const d = pointSegmentDist(pt(5, 4), pt(0, 0), pt(10, 0));
    assert.ok(Math.abs(d - 4) < 1e-9);
  });
});

describe("rdp", () => {
  test("keeps first and last points", () => {
    const points = [pt(0, 0), pt(50, 5), pt(100, 0)];
    const out = rdp(points, 100);
    assert.equal(out.length, 2);
    assert.deepEqual(out[0], points[0]);
    assert.deepEqual(out[out.length - 1], points[points.length - 1]);
  });

  test("forceKeep preserves corner indices through simplification", () => {
    const points = [pt(0, 0), pt(25, 0), pt(25, 40), pt(50, 40)];
    const out = rdp(points, 50, [2]);
    const ys = new Set(out.map((p) => p.y));
    assert.ok(ys.has(40), "forced index 2 (y=40) should survive high-epsilon RDP");
  });
});

describe("cornerIndices", () => {
  test("marks a sharp turn", () => {
    // CORNER_DOT ≈ -0.45 keeps turns sharper than ~117° (90° is not enough).
    const points = [pt(0, 0), pt(10, 0), pt(0, 5)];
    const idx = cornerIndices(points);
    assert.ok(idx.includes(1));
  });
});

describe("resamplePolyline", () => {
  test("spacing along polyline is roughly uniform", () => {
    const points = [pt(0, 0), pt(30, 0), pt(60, 0)];
    const spacing = 10;
    const out = resamplePolyline(points, spacing);
    assert.ok(out.length >= 3);
    const lens = segLengths(out);
    const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
    for (const len of lens) {
      assert.ok(
        Math.abs(len - mean) <= spacing * 0.6,
        `segment length ${len} too far from mean ${mean}`,
      );
    }
  });
});

describe("mergeCollinear", () => {
  test("removes redundant middle point on a straight line", () => {
    const points = [pt(0, 0), pt(5, 0), pt(10, 0)];
    const out = mergeCollinear(points, 0.5);
    assert.equal(out.length, 2);
    assert.deepEqual(out[0], points[0]);
    assert.deepEqual(out[1], points[2]);
  });
});

describe("simplifyStroke", () => {
  test("reduces noisy zigzag versus raw count", () => {
    const raw = [];
    for (let i = 0; i <= 20; i++) {
      raw.push(pt(i * 5, i % 2 === 0 ? 0 : 2));
    }
    const simplified = simplifyStroke(raw, { fidelity: 1 });
    assert.ok(simplified.length < raw.length);
    assert.ok(simplified.length >= 2);
  });

  test("grid option snaps output to grid", () => {
    const raw = [pt(1.2, 2.7), pt(9.8, 2.1), pt(19.4, 2.5)];
    const out = simplifyStroke(raw, { fidelity: 2, grid: 5 });
    for (const p of out) {
      assert.equal(p.x % 5, 0, `x ${p.x} not on grid 5`);
      assert.equal(p.y % 5, 0, `y ${p.y} not on grid 5`);
    }
  });
});

describe("oneEuroFilter", () => {
  test("smooths high-frequency noise on a straight move", () => {
    const sx = oneEuroCreate();
    const sy = oneEuroCreate();
    const raw = [];
    const smooth = [];
    let t = 0;
    for (let i = 0; i < 40; i++) {
      t += 16;
      const x = i + (i % 3 === 0 ? 2 : 0);
      const y = (i % 5 === 0 ? 3 : 0);
      raw.push({ x, y });
      smooth.push({
        x: oneEuroFilter(sx, x, t),
        y: oneEuroFilter(sy, y, t),
      });
    }
    let rawVar = 0;
    let smoothVar = 0;
    for (let i = 2; i < raw.length; i++) {
      rawVar += Math.abs(raw[i].y - raw[i - 1].y);
      smoothVar += Math.abs(smooth[i].y - smooth[i - 1].y);
    }
    assert.ok(smoothVar <= rawVar + 1, "filtered path should be no jerkier than raw");
    assert.ok(smooth[smooth.length - 1].x > smooth[0].x + 20);
  });
});

describe("eraseNearStrokes", () => {
  test("removes or splits strokes near eraser point", () => {
    const strokes = [
      { points: [pt(0, 0), pt(100, 0)] },
      { points: [pt(0, 50), pt(100, 50)] },
    ];
    const next = eraseNearStrokes(strokes, pt(50, 0), 8);
    assert.ok(Array.isArray(next));
    // Top line at y=0 should be erased; bottom line at y=50 should remain.
    const remainingYs = next.flatMap((s) => s.points.map((p) => p.y));
    assert.ok(remainingYs.every((y) => y === 50), "only the far stroke should remain");
    assert.equal(next.length, 1);
  });

  test("splits a multi-segment polyline around the brush", () => {
    const strokes = [
      {
        points: [pt(0, 0), pt(20, 0), pt(40, 0), pt(60, 0), pt(80, 0)],
        widths: [3, 3, 3, 3],
      },
    ];
    const next = eraseNearStrokes(strokes, pt(40, 0), 6);
    assert.ok(next.length >= 2, "eraser should leave leftover chunks on both sides");
    const xs = next.flatMap((s) => s.points.map((p) => p.x));
    assert.ok(xs.some((x) => x <= 20));
    assert.ok(xs.some((x) => x >= 60));
    assert.ok(!xs.includes(40));
  });
});

describe("snapToGrid", () => {
  test("snaps coordinates to nearest grid multiple", () => {
    const g = snapToGrid(pt(7, 13), 5);
    assert.deepEqual(g, pt(5, 15));
  });
});

describe("closeStrokeIfNear", () => {
  test("auto-close adds endpoint when start and end are within threshold", () => {
    const almost = [pt(0, 0), pt(40, 0), pt(40, 40), pt(3, 2)];
    const closed = closeStrokeIfNear(almost, 10);
    assert.ok(closed.length >= almost.length);
    const last = closed[closed.length - 1];
    const first = closed[0];
    assert.ok(Math.hypot(last.x - first.x, last.y - first.y) < 1e-6);
  });
});