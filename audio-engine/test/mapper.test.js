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
  RELEASE_TIME_MS,
  COOLDOWN_MS,
  BED_BPM,
  INPUT_MIN_BPM,
  INPUT_MAX_BPM,
  MAX_BPM_CHANGE_PER_SEC,
} from "../src/biometric-mapper.js";

import {
  ZONE_BANDS,
  CALM_ME_DOWN_BANDS,
  LIFT_ME_UP_BANDS,
  INTENTION_BANDS,
  classifyZone,
  createZoneTracker,
  bpmToPlaybackRateWithinZone,
  MIN_DWELL_MS,
} from "../src/biometric-zone-mapper.js";

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

test("stressMachine: intensity01 is exactly 0.0 at elapsed = RELEASE_TIME_MS (Fix B — no boundary jump)", () => {
  // Regression test for the exponential-decay bug where Math.exp(-1) ≈ 0.368
  // was hard-overridden to 0 in the same tick, causing a ~0.37 gain jump.
  // The linear decay formula must reach exactly 0 at the boundary with no override.
  const sm = createStressStateMachine();

  // Step 1: init at t=0.
  sm.update(70, 0);

  // Step 2-3: scripted rise above RISE_RATE_THRESHOLD for MIN_CONSECUTIVE_SAMPLES.
  const risePerSec = RISE_RATE_THRESHOLD + 6; // well above threshold
  sm.update(70 + risePerSec, 1000);   // risingCount = 1
  sm.update(70 + 2 * risePerSec, 2000); // risingCount = 2 → RISING (risingStartMs=2000, baseline≈70)

  // Step 4: dBpmDt drops → PEAK entered at t=3000; peakEntryMs=3000.
  sm.update(70 + 2 * risePerSec - 2, 3000); // dBpmDt = -2 <= 0 → PEAK
  assert.strictEqual(sm.getState(), STRESS_STATE.PEAK, "should be in PEAK after rise reversal");

  // Step 5: PEAK → RELEASING (one tick).
  sm.update(70 + 2 * risePerSec - 2, 4000);
  assert.strictEqual(sm.getState(), STRESS_STATE.RELEASING, "should be in RELEASING after PEAK tick");

  // Step 6: advance to exactly peakEntryMs + RELEASE_TIME_MS = 3000 + 6000 = 9000.
  // BPM is kept far from baseline (baseline ≈ 70, feeding 88 → |88-70|=18 > RELEASE_BAND_BPM=5)
  // to prevent early-exit via bpmNearBaseline.
  const intensity = sm.update(70 + 2 * risePerSec - 2, 3000 + RELEASE_TIME_MS);

  // Linear formula: max(0, 1 - 6000/6000) = 0 exactly.
  assert.strictEqual(intensity, 0, `intensity01 at RELEASE_TIME_MS boundary must be exactly 0, got ${intensity}`);
  assert.strictEqual(sm.getState(), STRESS_STATE.CALM, "should transition to CALM at boundary");
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

// ── Epic 9: classifyZone ──────────────────────────────────────────────────────────────────

test("classifyZone (match_my_energy): midpoints of each zone classify correctly", () => {
  assert.strictEqual(classifyZone(60),  "calm");
  assert.strictEqual(classifyZone(80),  "focused");
  assert.strictEqual(classifyZone(100), "dreamy");
  assert.strictEqual(classifyZone(120), "energised");
});

test("classifyZone (match_my_energy): boundary values go to the HIGHER zone (half-open intervals)", () => {
  // bpm exactly at boundary → goes up (calm.high=70 → focused, not calm)
  assert.strictEqual(classifyZone(70),  "focused");
  assert.strictEqual(classifyZone(90),  "dreamy");
  assert.strictEqual(classifyZone(110), "energised");
});

test("classifyZone (match_my_energy): out-of-range clamps to nearest zone", () => {
  assert.strictEqual(classifyZone(0),   "calm");      // below all bands
  assert.strictEqual(classifyZone(200), "energised"); // above all bands
});

test("classifyZone (calm_me_down): higher BPM threshold required for energetic zones", () => {
  // BPM 80 → calm_me_down: still calm (< 85); match_my_energy: focused
  assert.strictEqual(classifyZone(80, CALM_ME_DOWN_BANDS), "calm");
  // BPM 100 → calm_me_down: focused (85-105); match_my_energy: dreamy
  assert.strictEqual(classifyZone(100, CALM_ME_DOWN_BANDS), "focused");
  // BPM 115 → calm_me_down: dreamy (105-120); match_my_energy: energised
  assert.strictEqual(classifyZone(115, CALM_ME_DOWN_BANDS), "dreamy");
  // BPM 125 → calm_me_down: energised (120-130)
  assert.strictEqual(classifyZone(125, CALM_ME_DOWN_BANDS), "energised");
});

test("classifyZone (lift_my_energy): lower BPM threshold reaches energetic zones sooner", () => {
  // BPM 65 → lift_my_energy: focused (62-77); match_my_energy: calm
  assert.strictEqual(classifyZone(65, LIFT_ME_UP_BANDS), "focused");
  // BPM 80 → lift_my_energy: dreamy (77-95); match_my_energy: focused
  assert.strictEqual(classifyZone(80, LIFT_ME_UP_BANDS), "dreamy");
  // BPM 95 → lift_my_energy: energised (95-130); match_my_energy: dreamy
  assert.strictEqual(classifyZone(95, LIFT_ME_UP_BANDS), "energised");
  // BPM 55 → lift_my_energy: calm (50-62)
  assert.strictEqual(classifyZone(55, LIFT_ME_UP_BANDS), "calm");
});

test("classifyZone: all three strategies cover the full [50, 130] range without gaps", () => {
  for (const [name, bands] of Object.entries(INTENTION_BANDS)) {
    for (let bpm = 50; bpm <= 130; bpm++) {
      const zone = classifyZone(bpm, bands);
      assert.ok(
        ["calm", "focused", "dreamy", "energised"].includes(zone),
        `${name}: bpm=${bpm} produced unknown zone "${zone}"`
      );
    }
  }
});

test("INTENTION_BANDS: all three keys present and map to distinct objects", () => {
  assert.ok(INTENTION_BANDS.match_my_energy === ZONE_BANDS);
  assert.ok(INTENTION_BANDS.calm_me_down === CALM_ME_DOWN_BANDS);
  assert.ok(INTENTION_BANDS.lift_my_energy === LIFT_ME_UP_BANDS);
});

// ── Epic 9: createZoneTracker ─────────────────────────────────────────────────────────────

test("createZoneTracker: first update confirms immediately (switched=true, no dwell)", () => {
  const tracker = createZoneTracker(4000);
  const result = tracker.update("calm", 0);
  assert.strictEqual(result.zone, "calm");
  assert.strictEqual(result.switched, true);
  assert.strictEqual(tracker.getZone(), "calm");
});

test("createZoneTracker: same-zone update returns switched=false", () => {
  const tracker = createZoneTracker(4000);
  tracker.update("calm", 0);
  const result = tracker.update("calm", 1000);
  assert.strictEqual(result.switched, false);
  assert.strictEqual(result.zone, "calm");
});

test("createZoneTracker: zone change before dwell does NOT confirm", () => {
  const tracker = createZoneTracker(4000);
  tracker.update("calm", 0);
  // 1000ms later — still within 4000ms dwell window
  const result = tracker.update("focused", 1000);
  assert.strictEqual(result.zone, "calm");     // still calm
  assert.strictEqual(result.switched, false);
});

test("createZoneTracker: zone change confirms after dwell elapses", () => {
  const tracker = createZoneTracker(4000);
  tracker.update("calm", 0);
  // Pending focused starts at t=500
  tracker.update("focused", 500);
  // Still pending at t=4499 (4000ms - 1ms short)
  const before = tracker.update("focused", 4499);
  assert.strictEqual(before.zone, "calm");    // not yet switched
  // Confirmed at t=4500 (exactly dwell elapsed)
  const after = tracker.update("focused", 4500);
  assert.strictEqual(after.zone, "focused");
  assert.strictEqual(after.switched, true);
});

test("createZoneTracker: reverting to original zone resets the pending dwell", () => {
  const tracker = createZoneTracker(4000);
  tracker.update("calm", 0);
  tracker.update("focused", 500);   // start pending for focused
  tracker.update("calm",    1500);  // back to calm — cancels pending
  // Now try focused again — dwell restarts from t=2000, not t=500
  tracker.update("focused", 2000);
  const at5999 = tracker.update("focused", 5999); // only 3999ms since restart
  assert.strictEqual(at5999.zone, "calm");   // still pending
  const at6000 = tracker.update("focused", 6000); // 4000ms since t=2000
  assert.strictEqual(at6000.zone, "focused");
  assert.strictEqual(at6000.switched, true);
});

test("createZoneTracker: forceZone bypasses dwell and sets zone immediately", () => {
  const tracker = createZoneTracker(4000);
  tracker.update("calm", 0);
  // Force to energised without any dwell
  tracker.forceZone("energised");
  assert.strictEqual(tracker.getZone(), "energised");
  // Subsequent update for the same zone should report switched=false
  const result = tracker.update("energised", 100);
  assert.strictEqual(result.switched, false);
  assert.strictEqual(result.zone, "energised");
});

test("createZoneTracker: uses MIN_DWELL_MS as default", () => {
  // With default dwell, a change 1ms in should not confirm.
  const tracker = createZoneTracker(); // default MIN_DWELL_MS = 4000
  tracker.update("calm", 0);
  const result = tracker.update("focused", 1);
  assert.strictEqual(result.zone, "calm", "default MIN_DWELL_MS should prevent instant switch");
});

// ── Epic 9: bpmToPlaybackRateWithinZone ─────────────────────────────────────────────

test("bpmToPlaybackRateWithinZone: zone center → nudge factor exactly 1.0", () => {
  for (const [zone, { low, high, center }] of Object.entries(ZONE_BANDS)) {
    const pos = (center - low) / (high - low);   // should be 0.5 for all
    const expectedRate = (center / BED_BPM) * (0.92 + pos * 0.16);
    const rate = bpmToPlaybackRateWithinZone(center, zone);
    assert.ok(Math.abs(rate - expectedRate) < 0.0001,
      `${zone} center=${center} rate=${rate} expected=${expectedRate}`);
  }
});

test("bpmToPlaybackRateWithinZone: zone low edge → nudge -8% from center rate", () => {
  // At zone low, pos=0, nudge=0.92 (8% below center).
  const { low, center } = ZONE_BANDS.focused;
  const rate = bpmToPlaybackRateWithinZone(low, "focused");
  const expected = (center / BED_BPM) * 0.92;
  assert.ok(Math.abs(rate - expected) < 0.0001, `got ${rate}, expected ${expected}`);
});

test("bpmToPlaybackRateWithinZone: zone high edge → nudge +8% from center rate", () => {
  // At zone high, pos=1, nudge=1.08 (8% above center).
  const { high, center } = ZONE_BANDS.focused;
  const rate = bpmToPlaybackRateWithinZone(high, "focused");
  const expected = (center / BED_BPM) * 1.08;
  assert.ok(Math.abs(rate - expected) < 0.0001, `got ${rate}, expected ${expected}`);
});

test("bpmToPlaybackRateWithinZone: BPM above zone high clamps to high edge", () => {
  // Static mode: 130 BPM with pinnedZone=calm should clamp to calm.high=70
  const { high, center } = ZONE_BANDS.calm;
  const rateAtHigh   = bpmToPlaybackRateWithinZone(high, "calm");
  const rateAboveHigh = bpmToPlaybackRateWithinZone(130, "calm");
  assert.ok(Math.abs(rateAtHigh - rateAboveHigh) < 0.0001,
    `BPM=130 in pinnedZone=calm should clamp: ${rateAboveHigh} vs ${rateAtHigh}`);
});

test("bpmToPlaybackRateWithinZone: rate varies across zone (tempo nudge is active)", () => {
  // Rate at low < rate at center < rate at high.
  const { low, high } = ZONE_BANDS.dreamy;
  const rateAtLow  = bpmToPlaybackRateWithinZone(low,  "dreamy");
  const rateAtMid  = bpmToPlaybackRateWithinZone((low + high) / 2, "dreamy");
  const rateAtHigh = bpmToPlaybackRateWithinZone(high, "dreamy");
  assert.ok(rateAtLow < rateAtMid, `low rate ${rateAtLow} should be < mid ${rateAtMid}`);
  assert.ok(rateAtMid < rateAtHigh, `mid rate ${rateAtMid} should be < high ${rateAtHigh}`);
});

test("bpmToPlaybackRateWithinZone: works with alternate band tables (calm_me_down)", () => {
  // For calm_me_down, focused zone has center=95, low=85, high=105.
  const { center: c, low: l, high: h } = CALM_ME_DOWN_BANDS.focused;
  const rateCenter = bpmToPlaybackRateWithinZone(c, "focused", CALM_ME_DOWN_BANDS);
  const expectedCenter = (c / BED_BPM) * (0.92 + ((c - l) / (h - l)) * 0.16);
  assert.ok(Math.abs(rateCenter - expectedCenter) < 0.0001,
    `calm_me_down focused center: got ${rateCenter}, expected ${expectedCenter}`);
});
