/**
 * biometric-zone-mapper.js — Epic 3 (mood-zone version): Biometric-to-Zone Mapping
 *
 * Converts a heart-rate BPM value (from the Epic 1 biometrics pipeline) into
 * one of the mood zones in assets/ (calm/focused/dreamy/energised), plus a
 * small continuous playbackRate nudge within whichever zone is active.
 *
 * ── Why zones instead of Epic 3's original continuous playbackRate ─────────
 * The original Epic 3 (see git history / main branch) scaled a single fixed
 * fal.ai bed's playbackRate directly proportional to bpm (targetBPM/96).
 * That assumed one bed with one known BPM baked into its generation prompt.
 * This epic's bed is now a pool of hand-sourced, real-world tracks across
 * four mood zones with no consistent known BPM metadata — so a single
 * global "speed up the track" mapping doesn't make sense any more. Instead:
 * bpm picks the zone (the primary, obviously-audible response to heart
 * rate), and a modest ±TEMPO_RANGE playbackRate nudge based on bpm's
 * position *within* that zone's band adds a secondary, continuous layer of
 * responsiveness without requiring per-track BPM data.
 *
 * ── Zone bands ───────────────────────────────────────────────────────────
 * Reuses Epic 3's original clamp range (50–130 BPM) split into four equal
 * 20-BPM bands, ordered by arousal/energy (not valence) since that's the
 * one dimension bpm can actually track:
 *   calm (50–70) < focused (70–90) < dreamy (90–110) < energised (110–130)
 * This ordering is a first-pass judgment call, not a validated curve —
 * "dreamy" (upbeat/joyful) and "focused" (relaxed/feel-good) don't
 * obviously sit on a single bpm axis by mood alone, only by energy. Revisit
 * once there's a live performer to actually tune against (Epic 7).
 *
 * ── Hysteresis / dwell debounce ──────────────────────────────────────────
 * A bpm reading sitting right on a band edge would otherwise flip zones
 * every message. createZoneTracker() requires a candidate zone to be the
 * classification result for MIN_DWELL_MS continuously before it actually
 * commits to switching — short jitter across a boundary doesn't trigger a
 * zone change, sustained movement into a new band does.
 */

/** Input clamp bounds (BPM) — matches original Epic 3's range. */
export const INPUT_MIN_BPM = 50;
export const INPUT_MAX_BPM = 130;

/** Zone bands, in increasing energy order. */
export const ZONE_BANDS = [
  { zone: "calm", min: 50, max: 70 },
  { zone: "focused", min: 70, max: 90 },
  { zone: "dreamy", min: 90, max: 110 },
  { zone: "energised", min: 110, max: 130 },
];

/** Milliseconds a new zone classification must persist before actually switching. */
export const MIN_DWELL_MS = 4000;

/** Milliseconds without a biometric message before reverting to default tempo nudge. */
export const STALE_TIMEOUT_MS = 8000;

/** Continuous playbackRate nudge range applied within a zone's band (±8%). */
export const TEMPO_RANGE = 0.08;

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

/**
 * Classify a raw bpm into one of ZONE_BANDS' zone names (no hysteresis).
 * @param {number} bpm
 * @returns {string} zone name
 */
export function classifyZone(bpm) {
  const clamped = clamp(bpm, INPUT_MIN_BPM, INPUT_MAX_BPM);
  const band = ZONE_BANDS.find((b) => clamped >= b.min && clamped <= b.max) ?? ZONE_BANDS[0];
  return band.zone;
}

/**
 * Continuous playbackRate nudge based on bpm's position within a *given*
 * zone's band (not necessarily the zone classifyZone(bpm) would pick right
 * now) — e.g. bottom of the band -> 1 - TEMPO_RANGE, top -> 1 + TEMPO_RANGE.
 * Takes `zone` explicitly, rather than re-deriving it from bpm, because the
 * caller's committed zone (after hysteresis/dwell) can legitimately differ
 * from classifyZone(bpm) for a few seconds while a zone change is pending —
 * the tempo nudge during that window must stay relative to whatever zone
 * is actually still playing, not the target zone it's about to switch to.
 * bpm outside the given zone's band clamps (saturates at ±TEMPO_RANGE)
 * rather than extrapolating.
 * @param {number} bpm
 * @param {string} zone - The zone currently active (e.g. from createZoneTracker()).
 * @returns {number} playbackRate
 */
export function bpmToPlaybackRateWithinZone(bpm, zone) {
  const band = ZONE_BANDS.find((b) => b.zone === zone) ?? ZONE_BANDS[0];
  const clamped = clamp(bpm, band.min, band.max);
  const position01 = (clamped - band.min) / (band.max - band.min); // 0..1 within band
  return 1 - TEMPO_RANGE + position01 * (2 * TEMPO_RANGE);
}

/**
 * Create a stateful zone-with-hysteresis tracker. One instance per
 * connection/session.
 * @param {string} [initialZone] - Zone to start committed to.
 * @param {number} [dwellMs]
 * @returns {(bpm: number) => string} track — call once per incoming
 *   biometric message; returns the zone that should actually be active
 *   right now (already debounced — caller can compare to its last-applied
 *   zone to decide whether to call switchBed()).
 */
export function createZoneTracker(initialZone = "calm", dwellMs = MIN_DWELL_MS) {
  let committedZone = initialZone;
  let pendingZone = null;
  let pendingSince = null;

  return function track(bpm) {
    const candidate = classifyZone(bpm);

    if (candidate === committedZone) {
      pendingZone = null;
      pendingSince = null;
      return committedZone;
    }

    if (candidate !== pendingZone) {
      pendingZone = candidate;
      pendingSince = Date.now();
      return committedZone;
    }

    if (Date.now() - pendingSince >= dwellMs) {
      committedZone = candidate;
      pendingZone = null;
      pendingSince = null;
    }

    return committedZone;
  };
}
