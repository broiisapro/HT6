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
  clampBpm,
  createBpmRateLimiter,
  applyMoodInversion,
  createStressStateMachine,
  STRESS_STATE,
  RISE_RATE_THRESHOLD,
  MIN_CONSECUTIVE_SAMPLES,
  COOLDOWN_MS,
  BED_BPM,
  INPUT_MIN_BPM,
  INPUT_MAX_BPM,
  MAX_BPM_CHANGE_PER_SEC,
} from "../src/biometric-mapper.js";

import {
  pencilToAudioParams,
  quantizePitch,
  createVelocitySmoother,
  PENTATONIC_FREQS,
  PITCH_Y_MAX,
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

// ── clampBpm ────────────────────────────────────────────────────────────────

test("clampBpm: value within range passes through unchanged", () => {
  assert.strictEqual(clampBpm(96), 96);
  assert.strictEqual(clampBpm(INPUT_MIN_BPM), INPUT_MIN_BPM);
  assert.strictEqual(clampBpm(INPUT_MAX_BPM), INPUT_MAX_BPM);
});

test("clampBpm: value below INPUT_MIN_BPM clamps to INPUT_MIN_BPM", () => {
  assert.strictEqual(clampBpm(0), INPUT_MIN_BPM);
  assert.strictEqual(clampBpm(40), INPUT_MIN_BPM);
});

test("clampBpm: value above INPUT_MAX_BPM clamps to INPUT_MAX_BPM", () => {
  assert.strictEqual(clampBpm(200), INPUT_MAX_BPM);
  assert.strictEqual(clampBpm(180), INPUT_MAX_BPM);
});

// ── createBpmRateLimiter ──────────────────────────────────────────────────────

test("createBpmRateLimiter: first call returns target BPM unchanged (no history)", () => {
  const limit = createBpmRateLimiter(10);
  const result = limit(80, 0);
  assert.strictEqual(result, 80);
});

test("createBpmRateLimiter: delta within limit in 1s passes through unchanged", () => {
  const limit = createBpmRateLimiter(10);
  limit(72, 0);           // initialise at 72 BPM
  // 1 second later, target 78 BPM — delta=6 < max 10 BPM/s
  const result = limit(78, 1000);
  assert.strictEqual(result, 78);
});

test("createBpmRateLimiter: delta exceeding limit in 1s is capped (jumpscare fix)", () => {
  const limit = createBpmRateLimiter(10);
  limit(72, 0);           // initialise at 72 BPM
  // 1 second later, sudden spike to 122 BPM — delta=50, cap=10
  const result = limit(122, 1000);
  // Should only move 10 BPM → 82
  assert.ok(Math.abs(result - 82) < 0.001, `got ${result}, expected 82`);
});

test("createBpmRateLimiter: dt is capped at 1s so max delta is 10 BPM even over 2s gap", () => {
  // dt is capped to 1.0 s regardless of actual elapsed time. This ensures the
  // max BPM change per update is always 10 (not 20 for a 2-s gap, 300 for 30-s).
  const limit = createBpmRateLimiter(10);
  limit(72, 0);           // initialise at 72 BPM
  // 2 seconds later, spike to 122 BPM — dt capped to 1s → max delta = 10 BPM
  const result = limit(122, 2000);
  assert.ok(Math.abs(result - 82) < 0.001, `got ${result}, expected 82`);
});

test("createBpmRateLimiter: dt is capped at 1s even after a long pause", () => {
  // Simulates switching back from static mode after 30 seconds.
  // Without dt cap the limiter would allow a 300 BPM swing; with cap it
  // allows at most 10 BPM × 1s = 10 BPM from the pre-freeze state.
  const limit = createBpmRateLimiter(10);
  limit(72, 0);                    // initialise at 72 BPM
  const result = limit(130, 30000); // 30 seconds later, spike to max
  // dt is capped to 1s → max delta = 10 → effective = 82
  assert.ok(Math.abs(result - 82) < 0.001, `got ${result}, expected 82`);
});

test("createBpmRateLimiter: negative delta (BPM drop) is also capped", () => {
  const limit = createBpmRateLimiter(10);
  limit(120, 0);          // initialise at 120 BPM
  const result = limit(60, 1000); // 1 second later, sudden drop
  // Should only move -10 BPM → 110
  assert.ok(Math.abs(result - 110) < 0.001, `got ${result}, expected 110`);
});

test("createBpmRateLimiter: independent instances do not share state", () => {
  const a = createBpmRateLimiter(10);
  const b = createBpmRateLimiter(10);
  a(72, 0);
  b(100, 0);
  const ra = a(122, 1000); // capped from 72 → 82
  const rb = b(60, 1000);  // capped from 100 → 90
  assert.ok(Math.abs(ra - 82) < 0.001, `a got ${ra}, expected 82`);
  assert.ok(Math.abs(rb - 90) < 0.001, `b got ${rb}, expected 90`);
});

test("createBpmRateLimiter: uses MAX_BPM_CHANGE_PER_SEC as default", () => {
  // Confirm the exported default constant is wired correctly.
  const limit = createBpmRateLimiter(); // default maxBpmPerSec
  limit(72, 0);
  const result = limit(130, 1000);
  // Should cap at 72 + MAX_BPM_CHANGE_PER_SEC
  assert.ok(Math.abs(result - (72 + MAX_BPM_CHANGE_PER_SEC)) < 0.001,
    `got ${result}, expected ${72 + MAX_BPM_CHANGE_PER_SEC}`);
});

// ── jumpscare before/after simulation ────────────────────────────────────────
// Demonstrates the key Epic 8.5 invariant with concrete before/after numbers
// matching the documented evidence in docs/epic-8.5-mapping-hardening.md.

test("jumpscare fix: BPM spike 72→122 without limiter would jump 0.521 rate in 1s", () => {
  // BEFORE: raw mapping with no rate limiting
  const rateBefore = 72 / BED_BPM;  // 0.750
  const rateAfter  = 122 / BED_BPM; // 1.271
  const delta = rateAfter - rateBefore;
  assert.ok(Math.abs(delta - (50 / BED_BPM)) < 0.001, `delta was ${delta}`);
  assert.ok(delta > 0.5, `delta ${delta} should be a jarring lurch (>0.5 rate change)`);
});

test("jumpscare fix: BPM spike 72→122 WITH limiter ramps to only 82 BPM (0.104 rate change)", () => {
  // AFTER: with rate limiter at default 10 BPM/sec, 1-second update interval
  const limit = createBpmRateLimiter(MAX_BPM_CHANGE_PER_SEC);
  limit(72, 0);
  const effectiveBPM = limit(122, 1000); // 1 second later
  assert.ok(Math.abs(effectiveBPM - 82) < 0.001, `effective BPM=${effectiveBPM}, expected 82`);
  const rateBefore = 72 / BED_BPM;  // 0.750
  const rateAfter  = effectiveBPM / BED_BPM; // 0.854
  const delta = rateAfter - rateBefore;
  // 5x smaller jump than without limiter (0.104 vs 0.521)
  assert.ok(delta < 0.5 / 4, `rate delta ${delta.toFixed(3)} should be graceful (<0.125)`);
  assert.ok(Math.abs(delta - (10 / BED_BPM)) < 0.001, `delta=${delta.toFixed(4)}, expected ${(10 / BED_BPM).toFixed(4)}`);
});

// ── applyMoodInversion ────────────────────────────────────────────────────────

test("applyMoodInversion: INPUT_MIN_BPM → INPUT_MAX_BPM (slow HR becomes energetic output)", () => {
  const result = applyMoodInversion(INPUT_MIN_BPM);
  assert.strictEqual(result, INPUT_MAX_BPM);
});

test("applyMoodInversion: INPUT_MAX_BPM → INPUT_MIN_BPM (fast HR becomes calm output)", () => {
  const result = applyMoodInversion(INPUT_MAX_BPM);
  assert.strictEqual(result, INPUT_MIN_BPM);
});

test("applyMoodInversion: midpoint maps to midpoint", () => {
  const mid = (INPUT_MIN_BPM + INPUT_MAX_BPM) / 2; // 90
  const result = applyMoodInversion(mid);
  assert.strictEqual(result, mid);
});

test("applyMoodInversion: result stays within [INPUT_MIN_BPM, INPUT_MAX_BPM]", () => {
  for (const bpm of [50, 70, 96, 110, 130]) {
    const result = applyMoodInversion(bpm);
    assert.ok(
      result >= INPUT_MIN_BPM && result <= INPUT_MAX_BPM,
      `applyMoodInversion(${bpm}) = ${result} out of range`
    );
  }
});

test("applyMoodInversion: double inversion is a no-op (round-trip)", () => {
  for (const bpm of [50, 72, 96, 108, 130]) {
    const result = applyMoodInversion(applyMoodInversion(bpm));
    assert.ok(Math.abs(result - bpm) < 0.001, `double-invert(${bpm}) = ${result}`);
  }
});

test("applyMoodInversion: inverted mapping is still within playbackRate [0.52, 1.36]", () => {
  // The output of applyMoodInversion is still a valid clamped BPM,
  // so dividing by BED_BPM gives a valid playbackRate — no clamping needed.
  for (const bpm of [50, 96, 130]) {
    const inverted = applyMoodInversion(bpm);
    const rate = inverted / BED_BPM;
    assert.ok(rate >= INPUT_MIN_BPM / BED_BPM - 0.001 && rate <= INPUT_MAX_BPM / BED_BPM + 0.001,
      `rate ${rate} out of expected range for bpm=${bpm}`);
  }
});

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

// ── quantizePitch ─────────────────────────────────────────────────────────────────

test("quantizePitch: y=0 (top) → highest note (A4 = 440 Hz)", () => {
  const { freqHz, index } = quantizePitch(0);
  const n = PENTATONIC_FREQS.length;
  assert.ok(Math.abs(freqHz - PENTATONIC_FREQS[n - 1]) < 0.01,
    `y=0 should be highest note ${PENTATONIC_FREQS[n-1]}Hz, got ${freqHz}`);
  assert.strictEqual(index, n - 1);
});

test("quantizePitch: y=PITCH_Y_MAX (bottom) → lowest note (A3 = 220 Hz)", () => {
  const { freqHz, index } = quantizePitch(PITCH_Y_MAX);
  assert.ok(Math.abs(freqHz - PENTATONIC_FREQS[0]) < 0.01,
    `y=PITCH_Y_MAX should be lowest note ${PENTATONIC_FREQS[0]}Hz, got ${freqHz}`);
  assert.strictEqual(index, 0);
});

test("quantizePitch: result freq is always a member of PENTATONIC_FREQS", () => {
  // Sample 20 y values across the full range.
  for (let i = 0; i <= 20; i++) {
    const y = (i / 20) * PITCH_Y_MAX;
    const { freqHz } = quantizePitch(y);
    assert.ok(
      PENTATONIC_FREQS.some(f => Math.abs(f - freqHz) < 0.01),
      `quantizePitch(${y}) = ${freqHz} is not in PENTATONIC_FREQS`
    );
  }
});

test("quantizePitch: out-of-bounds y clamps (no crash, valid result)", () => {
  const { freqHz: low } = quantizePitch(-100);
  const { freqHz: high } = quantizePitch(PITCH_Y_MAX + 100);
  assert.ok(PENTATONIC_FREQS.some(f => Math.abs(f - low) < 0.01),
    `y=-100 should clamp to valid note, got ${low}`);
  assert.ok(PENTATONIC_FREQS.some(f => Math.abs(f - high) < 0.01),
    `y=PITCH_Y_MAX+100 should clamp to valid note, got ${high}`);
});

test("quantizePitch: each bucket edge maps to the expected note", () => {
  // Bucket i spans t in [i/n, (i+1)/n), where t=1-y/yMax.
  // At the exact upper edge of t for bucket i, we should get PENTATONIC_FREQS[i].
  const n = PENTATONIC_FREQS.length;
  for (let i = 0; i < n; i++) {
    // t value at the centre of bucket i
    const t = (i + 0.5) / n;
    const y = (1 - t) * PITCH_Y_MAX;
    const { freqHz, index } = quantizePitch(y);
    assert.strictEqual(index, i,
      `Bucket centre t=${t.toFixed(3)} y=${y.toFixed(1)}: expected index=${i}, got ${index}`);
    assert.ok(Math.abs(freqHz - PENTATONIC_FREQS[i]) < 0.01,
      `Bucket ${i}: expected ${PENTATONIC_FREQS[i]}Hz, got ${freqHz}Hz`);
  }
});

// ── createStressStateMachine ──────────────────────────────────────────────────────

test("stressMachine: steady-state BPM stays CALM", () => {
  const sm = createStressStateMachine();
  let now = 0;
  // Feed 10 messages with a steady 75 BPM (no rise)
  for (let i = 0; i < 10; i++) {
    now += 1000;
    sm.update(75, now);
  }
  assert.strictEqual(sm.getState(), STRESS_STATE.CALM, "steady signal must stay CALM");
});

test("stressMachine: scripted BPM rise sequence reaches PEAK", () => {
  const sm = createStressStateMachine();
  // First message: establishes baseline at 70 BPM.
  sm.update(70, 0);

  // Each subsequent message 1s later, rising at RISE_RATE_THRESHOLD + 1 BPM/sec.
  // Should trigger RISING after MIN_CONSECUTIVE_SAMPLES, then PEAK.
  const risePerSec = RISE_RATE_THRESHOLD + 2; // above threshold
  let bpm = 70;
  let reachedPeak = false;
  for (let i = 1; i <= 10; i++) {
    bpm += risePerSec;
    sm.update(bpm, i * 1000);
    if (sm.getState() === STRESS_STATE.PEAK || sm.getState() === STRESS_STATE.RELEASING) {
      reachedPeak = true;
      break;
    }
  }
  assert.ok(reachedPeak, `Expected PEAK or RELEASING, got ${sm.getState()}`);
});

test("stressMachine: cooldown blocks immediate re-trigger after RELEASING", () => {
  const sm = createStressStateMachine();
  // Manually drive through to CALM via forceCalm to simulate end of release.
  sm.update(70, 0);
  sm.forceCalm(); // returns to CALM, sets cooldown timer

  // Immediately try to trigger RISING — should be blocked by cooldown.
  const risePerSec = RISE_RATE_THRESHOLD + 5;
  let bpm = 70;
  for (let i = 1; i <= MIN_CONSECUTIVE_SAMPLES + 2; i++) {
    bpm += risePerSec;
    sm.update(bpm, i * 1000); // within COOLDOWN_MS (3s)
  }
  // Cooldown is 3000ms; we only advanced 3 seconds total at 1s/step.
  // State should still be CALM (blocked by cooldown).
  assert.strictEqual(
    sm.getState(), STRESS_STATE.CALM,
    `Cooldown should block re-trigger; got ${sm.getState()}`
  );
});

// ── createVelocitySmoother — EMA behaviour ─────────────────────────────────────────

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
