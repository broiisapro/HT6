/**
 * biometric-mapper.js — Epic 3: Biometric-to-Tempo Mapping
 *                        Epic 8.5: Mapping Hardening extensions
 *
 * Converts a heart-rate BPM value (from the Epic 1 biometrics pipeline) into a
 * Web Audio API `playbackRate` for the looping fal.ai bed in `playback.js`.
 *
 * ── Mapping curve ────────────────────────────────────────────────────────────
 * Curve: direct linear proportion — music tempo (via playbackRate) scales 1:1
 * with the incoming heart-rate BPM.
 *
 *   targetMusicBPM = clamp(heartBPM, INPUT_MIN, INPUT_MAX)
 *   playbackRate   = targetMusicBPM / BED_BPM
 *
 * BED_BPM = 96 (the tempo baked into the fal.ai bed generation prompt:
 *   "Tempo: 96 BPM" — see docs/epic-2-audio-engine-scaffold.md).
 * At playbackRate = 1.0 the bed plays at its original 96 BPM.
 *
 * Input clamp: 50–130 BPM.
 *   - Lower bound 50: covers genuinely slow resting heart rates without
 *     making the music so slow it loses groove.
 *   - Upper bound 130: covers a vigorous demo perturbation; higher values
 *     push playbackRate > 1.35, which audibly distorts the bed's pitch.
 *   - Upstream (biometrics/pipeline.py) already clamps outgoing BPM to
 *     40–180, so these bounds are a second-layer safety net.
 *
 * Why direct proportion?
 *   - Simple and predictable for a live hackathon demo.
 *   - The Polar Vantage M (primary demo source) showed 77–97.6 BPM across a
 *     calm 3-minute run → playbackRates 0.802–1.017 (~26% range), clearly
 *     audible as a tempo shift on the looping bed.
 *   - During active perturbation (breath-hold, brief movement) the range
 *     extends; at 130 BPM ceiling playbackRate = 1.354, a 35% speedup.
 *   - Non-linear alternatives (e.g. exponential) were considered but rejected:
 *     they would compress the musically interesting low end and exaggerate the
 *     high end, making the mapping feel arbitrary to a listener without adding
 *     perceptual benefit at 1/sec update granularity.
 *
 * ── Smoothing decision ───────────────────────────────────────────────────────
 * NO additional smoothing is applied here.
 *
 * Rationale: Epic 1's biometrics pipeline already applies RollingBpmSmoother
 * before emitting — window_size=5 for the Polar relay path and window_size=6
 * for the camera path (see docs/epic-1-biometric-source.md, "Smoothing
 * strategy" section). The pipeline emits ~1 message/second. At that cadence,
 * with pre-smoothed input, successive BPM values differ by a small increment
 * (e.g. 82.3 → 83.1 → 84.0 → ...), and the tempo change per step
 * (∆playbackRate ≈ ∆BPM / 96 ≈ 0.01 per 1 BPM step) is gradual enough that
 * no audible jitter was observed in integration testing. Adding another EWA
 * or moving average on top would only delay the tempo response further.
 * Observation: playbackRate changes at 1/sec produced smooth, continuous tempo
 * ramping — no step-function jumps or jitter.
 *
 * If a future source emits at much higher frequency (e.g. every 50ms) AND
 * shows noisy values, revisit with a short exponential smoother here.
 *
 * ── No-data fallback ────────────────────────────────────────────────────────
 * If no biometric message arrives within STALE_TIMEOUT_MS, the engine reverts
 * to playbackRate = 1.0 (the bed's native 96 BPM). This keeps music playing
 * at a sensible default whether or not biometrics/ is running.
 *
 * STALE_TIMEOUT_MS = 8000 ms (~8 missed updates at the ~1 msg/sec rate).
 * Long enough to absorb brief WebSocket reconnect gaps without false resets;
 * short enough to recover within one breath if the detector is restarted.
 *
 * ── Epic 8.5 extensions ──────────────────────────────────────────────────────
 * Three hardening features are layered on top of the base mapping:
 *
 * 1. Rate-of-change limiting (createBpmRateLimiter): caps how fast the
 *    effective BPM driving the music can move per second, converting sudden
 *    sensor spikes into graceful ramps. Applied AFTER clamp, BEFORE rate calc.
 *
 * 2. Mood inversion (applyMoodInversion): reflects the clamped BPM about the
 *    midpoint of [INPUT_MIN, INPUT_MAX] so that high BPM → calmer output and
 *    low BPM → more energetic output. Applied AFTER rate limiting.
 *
 * 3. Static/dynamic mode: implemented in server.js — when static, incoming
 *    messages are not applied; the music stays frozen at its current state.
 *
 * See docs/epic-8.5-mapping-hardening.md for full documentation.
 */

/** BPM at which the fal.ai bed was generated (from the generation prompt). */
export const BED_BPM = 96;

/** Input clamp lower bound (BPM). Upstream clamps to 40; this is more conservative. */
export const INPUT_MIN_BPM = 50;

/** Input clamp upper bound (BPM). Upstream clamps to 180; this limits pitch distortion. */
export const INPUT_MAX_BPM = 130;

/**
 * Milliseconds without a biometric message before reverting to default tempo.
 * ~8 missed updates at the ~1 msg/sec emission cadence.
 */
export const STALE_TIMEOUT_MS = 8000;

/**
 * Maximum BPM change allowed per second on the effective BPM driving the
 * music. Applied on top of (not instead of) Epic 1's RollingBpmSmoother.
 *
 * Value: 10 BPM/sec, chosen for musical grace:
 *   - At 96 BPM (native tempo), 10 BPM/sec ≈ 10% tempo change per second —
 *     comparable to a moderately fast ritardando/accelerando in live music.
 *   - A sudden physiological spike of 40 BPM (startle reflex, motion artifact)
 *     ramps over ~4 seconds: dramatic and audible, but a smooth ramp rather
 *     than an instant lurch.
 *   - The full usable range (50–130 BPM = 80 BPM span) traverses in ~8 seconds
 *     at maximum speed — graceful at demo scale.
 *   - Below 5 BPM/sec: sluggish; loses sense of performer connection.
 *   - Above 20 BPM/sec: insufficient protection against sensor artifacts.
 *
 * Jumpscare before/after (concrete simulation at 1s update interval):
 *   Spike scenario: BPM 72 → 122 in one update.
 *   BEFORE: playbackRate 0.750 → 1.271 (Δ=0.521 in 1 step — audible lurch).
 *   AFTER:  effective BPM 72 → 82,  playbackRate 0.750 → 0.854 (Δ=0.104 — graceful ramp).
 *   The spike is spread over ~5 subsequent 1-second updates instead.
 */
export const MAX_BPM_CHANGE_PER_SEC = 10;

/**
 * Clamp a raw heart-rate BPM to the valid input range [INPUT_MIN_BPM, INPUT_MAX_BPM].
 *
 * Exposed separately from bpmToPlaybackRate so that Epic 8.5's server.js can
 * interleave rate limiting and mood inversion between the clamp and the
 * final rate calculation without duplicating the clamp expression.
 *
 * @param {number} heartBPM
 * @returns {number} Clamped BPM in [INPUT_MIN_BPM, INPUT_MAX_BPM].
 */
export function clampBpm(heartBPM) {
  return Math.max(INPUT_MIN_BPM, Math.min(INPUT_MAX_BPM, heartBPM));
}

/**
 * Convert an incoming heart-rate BPM to a Web Audio `playbackRate` value.
 *
 * The base Epic 3 function — unchanged by Epic 8.5. When rate limiting and/or
 * mood inversion are active, server.js calls clampBpm + createBpmRateLimiter +
 * applyMoodInversion + (÷ BED_BPM) directly rather than going through this
 * convenience wrapper, so this function always reflects the raw linear mapping.
 *
 * @param {number} heartBPM - Raw BPM from the biometric contract message.
 * @returns {number}        - playbackRate to set on AudioBufferSourceNode.
 */
export function bpmToPlaybackRate(heartBPM) {
  return clampBpm(heartBPM) / BED_BPM;
}

/**
 * Create a stateful rate limiter for the effective BPM value driving the music.
 *
 * Caps how fast the effective BPM can change per second, regardless of how
 * large the incoming smoothed-BPM jump is. Applied AFTER Epic 1/3's clamp and
 * smoothing, not instead of them — it is the final guard before the rate calc.
 *
 * Algorithm:
 *   dt      = min((now - lastUpdateMs) / 1000, 1.0)   ← capped to avoid huge
 *   maxDelta = maxBpmPerSec × dt                        jump after a long pause
 *   effectiveBPM = lastBPM + clamp(targetBPM - lastBPM, -maxDelta, +maxDelta)
 *
 * The 1-second dt cap ensures that switching back from static mode (during
 * which the limiter's clock is paused) does not open a window for a large
 * single-step jump.
 *
 * @param {number} [maxBpmPerSec=MAX_BPM_CHANGE_PER_SEC]
 * @returns {(targetBPM: number, nowMs?: number) => number}
 */
export function createBpmRateLimiter(maxBpmPerSec = MAX_BPM_CHANGE_PER_SEC) {
  let lastEffectiveBPM = null;
  let lastUpdateMs = null;

  return function limit(targetBPM, nowMs = Date.now()) {
    if (lastEffectiveBPM === null) {
      // First call: no history — accept the value as-is so the limiter
      // initialises at the real current BPM rather than ramping from zero.
      lastEffectiveBPM = targetBPM;
      lastUpdateMs = nowMs;
      return targetBPM;
    }

    // Cap dt to 1 second to prevent a large allowed jump after a long pause
    // (e.g. resuming from static mode after 30 s).
    const dt = Math.min((nowMs - lastUpdateMs) / 1000, 1.0);
    const maxDelta = maxBpmPerSec * dt;
    const delta = targetBPM - lastEffectiveBPM;
    const effectiveBPM =
      Math.abs(delta) <= maxDelta
        ? targetBPM
        : lastEffectiveBPM + Math.sign(delta) * maxDelta;

    lastEffectiveBPM = effectiveBPM;
    lastUpdateMs = nowMs;
    return effectiveBPM;
  };
}

// ── Item 4: Stress-spike state machine ────────────────────────────────────────

/** BPM/sec rise rate required to enter RISING from CALM. */
export const RISE_RATE_THRESHOLD = 3.0;

/** Number of consecutive messages above RISE_RATE_THRESHOLD to enter RISING. */
export const MIN_CONSECUTIVE_SAMPLES = 2;

/** Milliseconds the triggered layer holds before decaying back to CALM. */
export const RELEASE_TIME_MS = 6000;

/**
 * BPM band: if BPM returns within this many BPM of the pre-rise baseline
 * while RELEASING, return to CALM early.
 */
export const RELEASE_BAND_BPM = 5.0;

/** Milliseconds before the state machine can re-arm after returning to CALM. */
export const COOLDOWN_MS = 3000;

/**
 * States for the stress-spike machine.
 * @readonly
 * @enum {string}
 */
export const STRESS_STATE = Object.freeze({
  CALM:      "CALM",
  RISING:    "RISING",
  PEAK:      "PEAK",
  RELEASING: "RELEASING",
});

/**
 * Create a stateful stress-spike state machine.
 *
 * Consumes consecutive biometric messages and returns an `intensity01` float
 * in [0, 1] representing the triggered-layer gain.  The caller drives a
 * separate audio chain (white noise → bandpass → gain) with this value.
 *
 * State transitions:
 *   CALM → RISING: dBpmDt > RISE_RATE_THRESHOLD, sustained for
 *                   MIN_CONSECUTIVE_SAMPLES messages.
 *   RISING → PEAK: dBpmDt falls back toward zero, OR 3s hard ceiling hit.
 *   PEAK → RELEASING: immediately on entering PEAK, begin timed decay.
 *   RELEASING → CALM: after RELEASE_TIME_MS, or BPM within RELEASE_BAND_BPM
 *                      of baseline.
 *   Any → CALM: forced by forceCalm() (stale biometric data).
 *
 * @returns {{ update(bpm, nowMs): number, forceCalm(): void, getState(): string }}
 */
export function createStressStateMachine() {
  let state        = STRESS_STATE.CALM;
  let lastBpm      = null;
  let lastTs       = null;
  let risingCount  = 0;           // consecutive above-threshold updates
  let risingStartMs = null;       // when we first entered RISING
  let baseline     = null;        // BPM at CALM→RISING transition
  let peakEntryMs  = null;        // timestamp of entering PEAK
  let calmReturnMs = null;        // timestamp of returning to CALM (for cooldown)
  let intensity01  = 0.0;

  // Attack/release time constants for intensity01 smoothing.
  const ATTACK_TC_MS  = 200;
  const RELEASE_TC_MS = RELEASE_TIME_MS;
  const RISING_HARD_CEILING_MS = 3000;

  function _decayIntensity(nowMs, referenceMs, tcMs) {
    const elapsed = nowMs - referenceMs;
    return Math.exp(-elapsed / tcMs);
  }

  /**
   * Advance the state machine with the next BPM sample.
   * @param {number} bpm   - Current smoothed/clamped BPM.
   * @param {number} nowMs - Current timestamp (Date.now()).
   * @returns {number} intensity01 in [0, 1].
   */
  function update(bpm, nowMs) {
    // First message: no history, can't compute dBpmDt.
    if (lastBpm === null || lastTs === null) {
      lastBpm = bpm;
      lastTs  = nowMs;
      baseline = bpm;
      return intensity01;
    }

    const dtSec = (nowMs - lastTs) / 1000;
    const dBpmDt = dtSec > 0 ? (bpm - lastBpm) / dtSec : 0;
    lastBpm = bpm;
    lastTs  = nowMs;

    switch (state) {
      case STRESS_STATE.CALM: {
        // Re-arm guard: cooldown after returning from RELEASING.
        if (calmReturnMs !== null && nowMs - calmReturnMs < COOLDOWN_MS) break;
        if (dBpmDt > RISE_RATE_THRESHOLD) {
          risingCount++;
          if (risingCount >= MIN_CONSECUTIVE_SAMPLES) {
            state = STRESS_STATE.RISING;
            risingStartMs = nowMs;
            baseline = bpm - dBpmDt * dtSec; // approximate BPM before the rise
          }
        } else {
          risingCount = 0;
        }
        break;
      }

      case STRESS_STATE.RISING: {
        const risingDuration = nowMs - (risingStartMs || nowMs);
        const hardCeilingHit = risingDuration >= RISING_HARD_CEILING_MS;
        if (dBpmDt <= 0 || hardCeilingHit) {
          // BPM is no longer rising, or we hit the time ceiling → fire PEAK.
          state      = STRESS_STATE.PEAK;
          peakEntryMs = nowMs;
          intensity01 = 1.0; // fast attack: instant on PEAK entry
          risingCount = 0;
        }
        break;
      }

      case STRESS_STATE.PEAK: {
        // Immediately transition to RELEASING.
        state = STRESS_STATE.RELEASING;
        break;
      }

      case STRESS_STATE.RELEASING: {
        // Exponential decay of intensity01.
        intensity01 = peakEntryMs !== null
          ? _decayIntensity(nowMs, peakEntryMs, RELEASE_TC_MS)
          : 0;

        const elapsed = peakEntryMs !== null ? nowMs - peakEntryMs : Infinity;
        const bpmNearBaseline = baseline !== null && Math.abs(bpm - baseline) <= RELEASE_BAND_BPM;
        if (elapsed >= RELEASE_TIME_MS || bpmNearBaseline) {
          state        = STRESS_STATE.CALM;
          intensity01  = 0;
          calmReturnMs = nowMs;
          risingCount  = 0;
        }
        break;
      }
    }

    return intensity01;
  }

  /**
   * Force state machine back to CALM (used by stale-data timeout).
   * Always resets history and arms the cooldown, regardless of current state,
   * so callers don't need to check state before calling.
   */
  function forceCalm() {
    state        = STRESS_STATE.CALM;
    intensity01  = 0;
    calmReturnMs = Date.now();
    risingCount  = 0;
    lastBpm      = null;
    lastTs       = null;
  }

  function getState() { return state; }

  return { update, forceCalm, getState };
}

/**
 * Invert the BPM position within [INPUT_MIN_BPM, INPUT_MAX_BPM].
 *
 * Used for the "opposite mood" toggle: high heart rate → calmer music output,
 * low heart rate → more energetic music output. Implemented as a reflection
 * about the midpoint of the clamped range:
 *
 *   invertedBPM = INPUT_MAX_BPM + INPUT_MIN_BPM - clampedBPM
 *
 * Concrete values (INPUT_MIN=50, INPUT_MAX=130):
 *   50  BPM (slow HR) → 130 BPM effective → playbackRate 1.354 (energetic output)
 *   96  BPM (mid HR)  →  84 BPM effective → playbackRate 0.875 (calmer output)
 *   130 BPM (fast HR) →  50 BPM effective → playbackRate 0.521 (slowest output)
 *
 * The output is always within [INPUT_MIN_BPM, INPUT_MAX_BPM], so no
 * additional clamping is needed after inversion.
 *
 * Applied AFTER rate limiting (limiting the raw physiological signal, not the
 * inverted one) and BEFORE the final ÷ BED_BPM calculation.
 *
 * @param {number} clampedBPM - Already-clamped BPM in [INPUT_MIN_BPM, INPUT_MAX_BPM].
 * @returns {number} Inverted BPM, still in [INPUT_MIN_BPM, INPUT_MAX_BPM].
 */
export function applyMoodInversion(clampedBPM) {
  return INPUT_MAX_BPM + INPUT_MIN_BPM - clampedBPM;
}
