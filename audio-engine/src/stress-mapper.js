/**
 * stress-mapper.js — Presage stress-index layer
 *
 * Converts the contract's `stress` field (0.0 calm – 1.0 tense, from the
 * Presage SmartSpectra source only — see contracts/README.md and
 * docs/presage-biometric-source.md) into a dry/wet mix for a soft-clip
 * "drive" (tension) effect, distinct from Epic 3's tempo (`bpm`) and Epic 6's
 * melody/timbre (`pencil`) controls — a third, independent layer.
 *
 * ── Why drive/distortion, not reverb ────────────────────────────────────────
 * A convolution reverb needs an impulse-response audio asset and another
 * committed file; a WaveShaper drive effect needs neither — a curve
 * generated once in code — and is at least as legible live: calm reads as a
 * clean bed, rising stress reads as an audibly grittier, more tense texture.
 * Cheapest effect that's still clearly audible and distinct from filter/pan/
 * tremolo (Epic 6) and playbackRate (Epic 3).
 *
 * ── Why dry/wet crossfade, not a dynamic curve ──────────────────────────────
 * Regenerating a WaveShaperNode's curve on every ~1/sec message is wasteful
 * and can click. Instead the curve is fixed (built once at startup by
 * makeDriveCurve()) and `stress` only controls a linear crossfade between
 * the dry (unprocessed) and wet (distorted) signal paths — smooth, cheap,
 * and unconditionally stable regardless of message rate.
 *
 * ── No-data fallback ─────────────────────────────────────────────────────────
 * If no biometric message carrying a non-null `stress` arrives within
 * STALE_TIMEOUT_MS, the mix reverts to fully dry (mix = 0) — the same
 * "silence means calm/default" convention as the other two layers. This is
 * also the correct behavior for phone-camera/Polar sources, which never
 * populate `stress` at all.
 */

/** Milliseconds without a non-null `stress` value before reverting to dry (mix=0). */
export const STALE_TIMEOUT_MS = 8000;

/**
 * Convert a normalized stress index into dry/wet gains that sum to 1.0.
 *
 * @param {number} stress - 0.0 (calm) – 1.0 (tense).
 * @returns {{dryGain: number, wetGain: number}}
 */
export function stressToDriveMix(stress) {
  const clamped = Math.max(0, Math.min(1, stress));
  return { dryGain: 1 - clamped, wetGain: clamped };
}

/**
 * Build a fixed soft-clip waveshaping curve for the drive effect.
 * Called once at startup (see playback.js) — not per-message.
 *
 * @param {number} amount - Drive intensity, roughly 0-50; higher = harder clip.
 * @param {number} samples - Curve resolution.
 * @returns {Float32Array}
 */
export function makeDriveCurve(amount = 20, samples = 1024) {
  const curve = new Float32Array(samples);
  const k = amount;
  for (let i = 0; i < samples; i++) {
    const x = (i * 2) / samples - 1;
    curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
  }
  return curve;
}
