/**
 * pencil-mapper.js — Epic 6: Pencil-to-Melody Mapping
 *
 * Ported unchanged from main's Epic 6 implementation — this mapping is
 * bed-agnostic (pure function of pencil input, doesn't know or care what's
 * playing underneath), so it applies to the mood-zone architecture without
 * modification. The persistent filterNode/pannerNode/lfo chain it targets
 * now lives in this branch's playback.js and survives zone switches (see
 * that file's docstring).
 *
 * Converts an incoming `type: "pencil"` contract message (pressure, x, y,
 * velocity, tilt) into melody/timbre parameters for the audio graph built in
 * `playback.js`: lowpass filter cutoff, tremolo (note-density proxy) rate,
 * and stereo pan. These are deliberately distinct AudioParams from Epic 3's
 * `sourceNode.playbackRate` (tempo) — the two epics never touch the same
 * knob, so biometric and pencil input can't fight each other.
 *
 * ── Which fields actually drive sound ───────────────────────────────────────
 * Epic 5's handback (docs/epic-5-pencil-networking.md, "Known limitations")
 * is the source of truth for what's live on the real hardware (10th-gen
 * iPad + USB-C Apple Pencil):
 *   - `pressure` is a HARDWARE CONSTANT (~0.240) — this Pencil has no force
 *     sensor. Mapping anything audible off it would be mapping off noise
 *     dressed as signal, so it is intentionally NOT used here.
 *   - `tilt` is real and live (never null with an active Pencil contact;
 *     only the desktop mouse mock sends `tilt: null`).
 *   - `velocity` is real but raw/noisy at low speed — smoothed here, not
 *     upstream (Epic 5 explicitly delegates smoothing to the receiver).
 * So: tilt and (smoothed) velocity are the primary drivers; x drives pan.
 * y is not mapped in this pass — no third melody parameter was needed once
 * tilt/velocity/x covered filter, tremolo, and pan, and adding one without a
 * clear audible purpose would just be an unused knob.
 *
 * ── Filter cutoff (brightness) ──────────────────────────────────────────────
 * brightness01 = tilt / TILT_MAX_DEG, clamped to [0, 1], when tilt is a
 * number. When tilt is null (mouse mock / hypothetical non-Pencil touch),
 * fall back to velocity-normalized brightness — the same fallback strategy
 * Epic 4/5's own local visualization already uses in `index.html`'s
 * `emit()` (`s.tiltDeg != null ? tilt-based : velocity-based`), so the
 * audio and visual feedback stay consistent for the performer.
 *
 * cutoffHz interpolates MIN_CUTOFF_HZ..MAX_CUTOFF_HZ *exponentially* (not
 * linearly) over brightness01, since human pitch/brightness perception of
 * filter cutoff is roughly logarithmic — a linear sweep would spend most of
 * its perceptual range in the first 10% of travel.
 *
 * ── Tremolo rate (note-density proxy) ───────────────────────────────────────
 * There's no separate synth/sequencer layer to vary actual note density
 * against (the audio source is a single looping bed, per Epic 2/3), so
 * tremolo rate — a periodic gain modulation on the output — stands in as an
 * audible "busier vs. sparser" texture that scales with stroke speed, which
 * is the closest live analog to note density available on this signal
 * chain. tremoloHz interpolates MIN_TREMOLO_HZ..MAX_TREMOLO_HZ linearly over
 * smoothed velocity, clamped to VELOCITY_MAX (linear is fine here — unlike
 * filter cutoff, there's no strong perceptual-logarithm argument for LFO
 * rate at these small values).
 *
 * Velocity smoothing: EMA with VELOCITY_SMOOTHING_ALPHA = 0.2, the same
 * alpha Epic 4 already validated for its own HUD velocity readout — reusing
 * a tuned value instead of guessing a new one.
 *
 * ── Pan ──────────────────────────────────────────────────────────────────
 * x is raw canvas CSS pixels (no canvas-size field in the contract). Rather
 * than adaptively track observed min/max (more moving parts than a 36-hour
 * build needs), this assumes the 10th-gen iPad's landscape CSS viewport
 * width (~1180pt, from Apple's published viewport for this device — the
 * only hardware Epic 4/5 tested against). pan is clamp(x, 0, X_MAX)
 * normalized linearly to [-1, 1]. If a different device/orientation is used
 * on demo day, worst case pan sits off-center rather than breaking.
 *
 * ── No-data fallback ────────────────────────────────────────────────────────
 * If no pencil message arrives within STALE_TIMEOUT_MS, the caller (server.js)
 * should revert filter/tremolo/pan to DEFAULT_CUTOFF_HZ / DEFAULT_TREMOLO_HZ /
 * DEFAULT_PAN. STALE_TIMEOUT_MS is much shorter than Epic 3's biometric
 * 8000ms: pencil streams at up to 30 msg/s while actively drawing (vs.
 * biometric's ~1 msg/s), so a multi-second gap reliably means the performer
 * lifted the Pencil, not just one dropped frame.
 */

// ── Item 5: Pencil melody pitch quantization ──────────────────────────────────

/**
 * A-minor pentatonic pitches: A3 C4 D4 E4 G4 A4 (low → high).
 * Canvas y is inverted: y=0 = top of screen = highest note.
 */
export const PENTATONIC_FREQS = [220.00, 261.63, 293.66, 329.63, 392.00, 440.00];

/**
 * Maximum y coordinate (CSS px) for pitch quantization.
 * Hardcoded to 10th-gen iPad landscape CSS viewport height.
 */
export const PITCH_Y_MAX = 820;

/**
 * Map canvas y position to the nearest A-minor pentatonic frequency.
 *
 * y=0 (top of canvas) → highest note (440 Hz).
 * y=PITCH_Y_MAX (bottom) → lowest note (220 Hz).
 *
 * Returns both the frequency and the bucket index so callers can detect
 * retrigger-on-bucket-change without computing the index separately.
 *
 * @param {number} y        - Canvas y in CSS px.
 * @param {number} [yMax=PITCH_Y_MAX]
 * @returns {{ freqHz: number, index: number }}
 */
export function quantizePitch(y, yMax = PITCH_Y_MAX) {
  const n = PENTATONIC_FREQS.length;                    // 6 notes
  const clamped = Math.max(0, Math.min(yMax, y));       // guard edges
  // Invert: y=0 → t=1 (highest note), y=yMax → t=0 (lowest note).
  const t = 1 - clamped / yMax;
  // Map t uniformly to one of n buckets.
  const index = Math.min(n - 1, Math.floor(t * n));
  return { freqHz: PENTATONIC_FREQS[index], index };
}

/** Tilt (degrees from vertical) treated as "fully bright". Real range is 0–90. */
export const TILT_MAX_DEG = 90;

/** Assumed velocity (px/s) at which brightness fallback (no tilt) saturates. */
export const VELOCITY_FALLBACK_MAX = 1500;

/** Lowpass filter cutoff range (Hz), dark to bright. */
export const MIN_CUTOFF_HZ = 300;
export const MAX_CUTOFF_HZ = 8000;
/** Cutoff applied when no pencil data is live (fully open — inaudible/neutral). */
export const DEFAULT_CUTOFF_HZ = MAX_CUTOFF_HZ;

/** Tremolo (note-density proxy) rate range (Hz) and its idle default. */
export const MIN_TREMOLO_HZ = 0.5;
export const MAX_TREMOLO_HZ = 8;
export const DEFAULT_TREMOLO_HZ = MIN_TREMOLO_HZ;

/** Velocity (px/s) clamp ceiling for the tremolo-rate mapping. */
export const VELOCITY_MAX = 2000;

/** EMA smoothing factor for raw velocity (matches Epic 4's HUD readout). */
export const VELOCITY_SMOOTHING_ALPHA = 0.2;

/** Assumed canvas x range (CSS px) — 10th-gen iPad landscape viewport width. */
export const X_MIN = 0;
export const X_MAX = 1180;
/** Pan applied when no pencil data is live (centered). */
export const DEFAULT_PAN = 0;

/**
 * Milliseconds without a pencil message before reverting to default
 * filter/tremolo/pan. Short relative to Epic 3's biometric timeout because
 * pencil emits far more frequently while actively drawing.
 */
export const STALE_TIMEOUT_MS = 2000;

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

/**
 * Create a stateful EMA smoother for raw velocity. One instance per
 * connection/session — velocity is inherently a running signal, not a pure
 * per-message conversion, so this can't be a plain function like the others.
 *
 * @param {number} [alpha=VELOCITY_SMOOTHING_ALPHA]
 * @returns {(raw: number) => number} smooth — call once per incoming message.
 */
export function createVelocitySmoother(alpha = VELOCITY_SMOOTHING_ALPHA) {
  let smoothed = null;
  return function smooth(raw) {
    smoothed = smoothed === null ? raw : smoothed * (1 - alpha) + raw * alpha;
    return smoothed;
  };
}

/**
 * Convert a pencil contract message (with velocity already EMA-smoothed by
 * the caller via createVelocitySmoother) into melody/timbre AudioParam
 * targets.
 *
 * @param {object} input
 * @param {number} input.x - Canvas x (CSS px).
 * @param {number} input.velocity - Smoothed velocity (px/s).
 * @param {number|null} input.tilt - Degrees from vertical, or null.
 * @returns {{ cutoffHz: number, tremoloHz: number, pan: number }}
 */
export function pencilToAudioParams({ x, velocity, tilt }) {
  const brightness01 =
    tilt != null
      ? clamp(tilt / TILT_MAX_DEG, 0, 1)
      : clamp(velocity / VELOCITY_FALLBACK_MAX, 0, 1);

  // Exponential interpolation: MIN * (MAX/MIN)^t
  const cutoffHz = MIN_CUTOFF_HZ * Math.pow(MAX_CUTOFF_HZ / MIN_CUTOFF_HZ, brightness01);

  const velocityClamped = clamp(velocity, 0, VELOCITY_MAX);
  const tremoloHz =
    MIN_TREMOLO_HZ + (velocityClamped / VELOCITY_MAX) * (MAX_TREMOLO_HZ - MIN_TREMOLO_HZ);

  const xClamped = clamp(x, X_MIN, X_MAX);
  const pan = ((xClamped - X_MIN) / (X_MAX - X_MIN)) * 2 - 1;

  return { cutoffHz, tremoloHz, pan };
}
