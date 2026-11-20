import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  COLOR_EFFECT_MODES,
  normalizeColorEffect,
  strokeColorFor,
} from "../build/dev/javascript/animator/color_effects.mjs";

const primary = "#e8d8b0";
const secondary = "#8a8aca";

function color(mode, index = 0, tSec = 0.5) {
  return strokeColorFor({
    mode,
    index,
    count: 20,
    tSec,
    mid: { x: index * 10 - 100, y: 40 },
    primary,
    secondary,
  });
}

describe("COLOR_EFFECT_MODES", () => {
  test("includes the ten new effects plus the original five", () => {
    assert.equal(COLOR_EFFECT_MODES.length, 15);
    for (const m of [
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
    ]) {
      assert.ok(COLOR_EFFECT_MODES.includes(m), m);
    }
  });
});

describe("normalizeColorEffect", () => {
  test("falls back to static for unknown modes", () => {
    assert.equal(normalizeColorEffect("nope"), "static");
    assert.equal(normalizeColorEffect("Rainbow"), "rainbow");
  });
});

describe("strokeColorFor", () => {
  test("every mode returns a usable CSS colour string", () => {
    for (const mode of COLOR_EFFECT_MODES) {
      const c = color(mode, 3, 1.25);
      assert.match(c, /^(#[0-9a-fA-F]{6}|rgb\(\d+,\d+,\d+\))$/, mode);
    }
  });

  test("strobe alternates palette colours", () => {
    assert.equal(color("strobe", 0, 0.0), primary);
    assert.equal(color("strobe", 0, 0.13), secondary);
  });

  test("static alternates by index", () => {
    assert.equal(color("static", 0), primary);
    assert.equal(color("static", 1), secondary);
  });

  test("rainbow changes with index", () => {
    assert.notEqual(color("rainbow", 0, 0), color("rainbow", 8, 0));
  });
});
