/**
 * mapper.test.js — Unit tests for biometric-mapper.js and pencil-mapper.js.
 *
 * These are all pure / stateless functions (or a simple stateful closure for
 * createVelocitySmoother), so no audio graph or WebSocket mocking is needed.
 * Run with: npm test   (which calls: node --test test/mapper.test.js)
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  bpmToPlaybackRate,
  BED_BPM,
  INPUT_MIN_BPM,
  INPUT_MAX_BPM,
} from "../src/biometric-mapper.js";

import {
  pencilToAudioParams,
  createVelocitySmoother,
  MIN_CUTOFF_HZ,
  MAX_CUTOFF_HZ,
  DEFAULT_CUTOFF_HZ,
  MIN_TREMOLO_HZ,
  MAX_TREMOLO_HZ,
  VELOCITY_MAX,
  VELOCITY_FALLBACK_MAX,
  TILT_MAX_DEG,
  X_MIN,
  X_MAX,
  VELOCITY_SMOOTHING_ALPHA,
} from "../src/pencil-mapper.js";

// ── bpmToPlaybackRate ────────────────────────────────────────────────────────

test("bpmToPlaybackRate: 96 BPM (bed native tempo) → playbackRate exactly 1.0", () => {
  assert.strictEqual(bpmToPlaybackRate(96), 1.0);
});

test("bpmToPlaybackRate: clamps low — input 50 (INPUT_MIN_BPM) → 50/96", () => {
  const expected = INPUT_MIN_BPM / BED_BPM;
  assert.strictEqual(bpmToPlaybackRate(INPUT_MIN_BPM), expected);
  // Values below the floor clamp to the same result.
  assert.strictEqual(bpmToPlaybackRate(10), expected);
  assert.strictEqual(bpmToPlaybackRate(0), expected);
});

test("bpmToPlaybackRate: clamps high — input 130 (INPUT_MAX_BPM) → 130/96", () => {
  const expected = INPUT_MAX_BPM / BED_BPM;
  assert.strictEqual(bpmToPlaybackRate(INPUT_MAX_BPM), expected);
  // Values above the ceiling clamp to the same result.
  assert.strictEqual(bpmToPlaybackRate(200), expected);
});

test("bpmToPlaybackRate: mid-range — 80 BPM → ~0.8333 (doc worked example)", () => {
  const rate = bpmToPlaybackRate(80);
  // Doc table: 80 BPM → 0.8333.
  assert.ok(Math.abs(rate - 0.8333) < 0.0001, `got ${rate}`);
});

// ── pencilToAudioParams — tilt as a number ───────────────────────────────────

test("pencilToAudioParams: tilt=0 → minimum cutoff (darkest)", () => {
  const { cutoffHz } = pencilToAudioParams({ x: 590, velocity: 500, tilt: 0 });
  // tilt=0 → brightness01=0 → exponential at t=0 → MIN_CUTOFF_HZ.
  assert.ok(Math.abs(cutoffHz - MIN_CUTOFF_HZ) < 1, `got ${cutoffHz}`);
});

test("pencilToAudioParams: tilt=TILT_MAX_DEG → maximum cutoff (brightest)", () => {
  const { cutoffHz } = pencilToAudioParams({ x: 590, velocity: 500, tilt: TILT_MAX_DEG });
  // tilt=90 → brightness01=1 → exponential at t=1 → MAX_CUTOFF_HZ.
  assert.ok(Math.abs(cutoffHz - MAX_CUTOFF_HZ) < 1, `got ${cutoffHz}`);
});

test("pencilToAudioParams: tilt mid-range (45°) → cutoff between min and max", () => {
  const { cutoffHz } = pencilToAudioParams({ x: 590, velocity: 500, tilt: 45 });
  assert.ok(cutoffHz > MIN_CUTOFF_HZ && cutoffHz < MAX_CUTOFF_HZ, `got ${cutoffHz}`);
});

// ── pencilToAudioParams — tilt: null fallback ────────────────────────────────

test("pencilToAudioParams: tilt=null falls back to velocity for brightness", () => {
  // With tilt null, brightness01 = velocity / VELOCITY_FALLBACK_MAX.
  const velocityHalf = VELOCITY_FALLBACK_MAX / 2;
  const { cutoffHz: withNull } = pencilToAudioParams({ x: 590, velocity: velocityHalf, tilt: null });
  const { cutoffHz: withTilt } = pencilToAudioParams({ x: 590, velocity: velocityHalf, tilt: 45 });
  // They should differ (the fallback uses a different brightness value).
  // Both should be within [MIN, MAX].
  assert.ok(withNull >= MIN_CUTOFF_HZ && withNull <= MAX_CUTOFF_HZ, `cutoff ${withNull} out of range`);
  // Confirm: tilt=null at half-fallback-velocity should give MIN*(MAX/MIN)^0.5.
  const expectedCutoff = MIN_CUTOFF_HZ * Math.pow(MAX_CUTOFF_HZ / MIN_CUTOFF_HZ, 0.5);
  assert.ok(Math.abs(withNull - expectedCutoff) < 1, `got ${withNull}, expected ~${expectedCutoff}`);
});

test("pencilToAudioParams: tilt=null does NOT throw, does NOT return NaN", () => {
  const result = pencilToAudioParams({ x: 590, velocity: 1000, tilt: null });
  assert.ok(!Number.isNaN(result.cutoffHz), "cutoffHz is NaN");
  assert.ok(!Number.isNaN(result.tremoloHz), "tremoloHz is NaN");
  assert.ok(!Number.isNaN(result.pan), "pan is NaN");
});

// ── pencilToAudioParams — velocity / tremolo range ───────────────────────────

test("pencilToAudioParams: velocity=0 → minimum tremolo rate", () => {
  const { tremoloHz } = pencilToAudioParams({ x: 590, velocity: 0, tilt: 45 });
  assert.ok(Math.abs(tremoloHz - MIN_TREMOLO_HZ) < 0.001, `got ${tremoloHz}`);
});

test("pencilToAudioParams: velocity >= VELOCITY_MAX → maximum tremolo rate (clamped)", () => {
  const { tremoloHz } = pencilToAudioParams({ x: 590, velocity: VELOCITY_MAX, tilt: 45 });
  assert.ok(Math.abs(tremoloHz - MAX_TREMOLO_HZ) < 0.001, `got ${tremoloHz}`);
  // Above the cap still clamps.
  const { tremoloHz: overCap } = pencilToAudioParams({ x: 590, velocity: VELOCITY_MAX * 2, tilt: 45 });
  assert.ok(Math.abs(overCap - MAX_TREMOLO_HZ) < 0.001, `got ${overCap}`);
});

// ── pencilToAudioParams — x / pan range ─────────────────────────────────────

test("pencilToAudioParams: x=X_MIN → pan=-1 (full left)", () => {
  const { pan } = pencilToAudioParams({ x: X_MIN, velocity: 500, tilt: 45 });
  assert.ok(Math.abs(pan - (-1)) < 0.001, `got ${pan}`);
});

test("pencilToAudioParams: x=X_MAX → pan=+1 (full right)", () => {
  const { pan } = pencilToAudioParams({ x: X_MAX, velocity: 500, tilt: 45 });
  assert.ok(Math.abs(pan - 1) < 0.001, `got ${pan}`);
});

test("pencilToAudioParams: x=center → pan~0", () => {
  const { pan } = pencilToAudioParams({ x: (X_MIN + X_MAX) / 2, velocity: 500, tilt: 45 });
  assert.ok(Math.abs(pan) < 0.001, `got ${pan}`);
});

test("pencilToAudioParams: x out of bounds clamps to [-1, 1]", () => {
  const { pan: left } = pencilToAudioParams({ x: -999, velocity: 500, tilt: 45 });
  const { pan: right } = pencilToAudioParams({ x: 99999, velocity: 500, tilt: 45 });
  assert.ok(Math.abs(left - (-1)) < 0.001, `got ${left}`);
  assert.ok(Math.abs(right - 1) < 0.001, `got ${right}`);
});

// ── createVelocitySmoother — EMA behaviour ───────────────────────────────────

test("createVelocitySmoother: first call returns raw value (no prior state)", () => {
  const smooth = createVelocitySmoother();
  const result = smooth(500);
  // smoothed === null initially → smoothed = raw on first call.
  assert.strictEqual(result, 500);
});

test("createVelocitySmoother: second call blends at alpha=0.2 (doc value)", () => {
  const smooth = createVelocitySmoother(VELOCITY_SMOOTHING_ALPHA);
  smooth(500);                    // initialises smoothed = 500
  const result = smooth(1000);   // EMA: 500*(1-0.2) + 1000*0.2 = 400 + 200 = 600
  assert.ok(Math.abs(result - 600) < 0.001, `got ${result}`);
});

test("createVelocitySmoother: repeated same value converges to that value", () => {
  const smooth = createVelocitySmoother();
  let v = smooth(100);
  for (let i = 0; i < 50; i++) v = smooth(100);
  assert.ok(Math.abs(v - 100) < 0.001, `did not converge: ${v}`);
});

test("createVelocitySmoother: each smoother instance is independent", () => {
  const a = createVelocitySmoother();
  const b = createVelocitySmoother();
  a(200);
  b(800);
  const ra = a(200);   // EMA starting at 200
  const rb = b(800);   // EMA starting at 800
  // They must have independent state.
  assert.notStrictEqual(ra, rb);
});
