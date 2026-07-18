/**
 * biometric-mapper.js — Epic 3: Biometric-to-Tempo Mapping
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
 * Convert an incoming heart-rate BPM to a Web Audio `playbackRate` value.
 *
 * @param {number} heartBPM - Raw BPM from the biometric contract message.
 * @returns {number}        - playbackRate to set on AudioBufferSourceNode.
 */
export function bpmToPlaybackRate(heartBPM) {
  const clamped = Math.max(INPUT_MIN_BPM, Math.min(INPUT_MAX_BPM, heartBPM));
  return clamped / BED_BPM;
}
