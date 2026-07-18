/**
 * mood-classifier.js — Epic 9: Music-Type Classification
 *
 * Classifies the current performer state into one of three mood categories
 * (calm / energetic / tense) based on the rate-limited BPM signal from
 * biometric-mapper.js (Epic 8.5) and the smoothed pencil velocity from
 * pencil-mapper.js (Epic 6), then drives crossfades between the corresponding
 * pre-rendered mood stems in playback.js.
 *
 * ── Mood categories and thresholds ──────────────────────────────────────────
 * All thresholds are grounded in Epic 1's actual observed BPM data:
 *   - Polar Vantage M, calm 3-min run: 77.0–97.6 BPM (Epic 1 doc)
 *   - Polar perturbed (in Epic 3 test): up to ~103 BPM
 *   - Camera PPG, flash-on best case: 52.93–118.63 BPM
 *
 * Category boundaries (base, before hysteresis):
 *   CALM      : effectiveBpm  < 80
 *   ENERGETIC : 80 ≤ effectiveBpm < 96
 *   TENSE     : effectiveBpm ≥ 96
 *
 * Rationale:
 *   - 80 BPM separates genuine rest from active performance. The Polar calm-run
 *     floor is 77 BPM, so setting the CALM/ENERGETIC boundary at 80 means the
 *     system stays in ENERGETIC for the bulk of a real Polar performance session
 *     (77–97.6 BPM), switching to CALM only when truly resting.
 *   - 96 BPM is BED_BPM — the natural midpoint — and aligns with the top of the
 *     Polar calm range (97.6 BPM). At ≥96 BPM the performer is approaching the
 *     Polar perturbation range, which is the intended TENSE trigger.
 *
 * ── Pencil velocity contribution ────────────────────────────────────────────
 * Smoothed pencil velocity adds up to VELOCITY_BONUS_MAX_BPM (8) to the
 * effective BPM used for classification. At 1500 px/s (Epic 6 VELOCITY_MAX),
 * the full 8-BPM bonus is added. This lets fast, energetic drawing nudge the
 * system toward ENERGETIC or TENSE even when BPM alone sits at the boundary —
 * matching the performer's physical energy level more holistically.
 *
 * ── Hysteresis ──────────────────────────────────────────────────────────────
 * Boundary dead-band: HYSTERESIS_BPM = 4.
 *   - From CALM: must reach 84+ (80+4) to switch to ENERGETIC.
 *   - From ENERGETIC: must drop below 76 (80−4) to switch to CALM,
 *                     or reach 100+ (96+4) to switch to TENSE.
 *   - From TENSE: must drop below 92 (96−4) to switch to ENERGETIC.
 *
 * Dwell time: DWELL_MS = 2000.
 *   - Signal must stay past the boundary for 2 continuous seconds before
 *     the switch is committed. Prevents flickering on the noisy camera-PPG
 *     path (which can swing ±10 BPM faster than the Polar path).
 *   - Combined with the 5 BPM/sec rate cap, a realistic spike takes ≥ 8 s
 *     to cross a boundary and dwell long enough to commit — far too slow for
 *     a motion artifact to trigger a spurious mood change.
 *
 * ── Composition with Epic 8.5 toggles ───────────────────────────────────────
 * The caller (server.js) passes liveState.staticMode and liveState.oppositeMood.
 * When staticMode is true, the caller skips feeding the classifier entirely.
 * When oppositeMood is true, the caller inverts the returned mood before
 * passing it to crossfadeTo(): CALM↔TENSE, ENERGETIC stays ENERGETIC.
 *
 * ── Direct/indirect classification ─────────────────────────────────────────
 * Transitions only cross one boundary at a time (CALM↔ENERGETIC↔TENSE) — a
 * signal can't jump directly from CALM to TENSE. In practice this is fine:
 * a signal climbing from 77 to 103 BPM must pass through 80 and 96 sequentially
 * at a rate-limited 5 BPM/s, giving each mood time to be heard.
 */

/** Base BPM boundaries (before hysteresis) */
export const BOUNDARY_CALM_ENERGETIC = 80;
export const BOUNDARY_ENERGETIC_TENSE = 96;

/** Dead-band width: must move this many BPM past a boundary before switching. */
export const HYSTERESIS_BPM = 4;

/**
 * How long the signal must stay past a boundary before the switch commits.
 * Guards against brief spikes (especially on the camera-PPG noise floor).
 */
export const DWELL_MS = 2000;

/** Max velocity (px/s) for the pencil velocity → BPM bonus mapping. */
export const VELOCITY_BONUS_VELOCITY_MAX = 1500;

/** Max BPM equivalent contribution from full-speed pencil strokes. */
export const VELOCITY_BONUS_MAX_BPM = 8;

/** Ordered list of moods (lowest to highest energy). */
export const MOODS = /** @type {const} */ (["calm", "energetic", "tense"]);

/** The inverted mapping for the opposite-mood toggle (CALM↔TENSE, ENERGETIC stays). */
export const MOOD_INVERSE = { calm: "tense", energetic: "energetic", tense: "calm" };

/**
 * Stateful mood classifier with hysteresis and dwell-time guard.
 *
 * Typical usage:
 *   const classifier = new MoodClassifier();
 *   // In biometric message handler (after rate limiting):
 *   const newMood = classifier.feed(rateLimitedBpm, smoothedPencilVelocity);
 *   if (newMood) crossfadeTo(newMood);
 */
export class MoodClassifier {
  constructor() {
    /** @type {"calm"|"energetic"|"tense"} */
    this._currentMood = "energetic"; // Default: energetic (the original bed character)
    /** @type {"calm"|"energetic"|"tense"|null} */
    this._pendingMood = null;        // Candidate mood we're considering switching to
    this._pendingStart = null;       // Timestamp (Date.now()) when candidate first seen
  }

  /** @returns {"calm"|"energetic"|"tense"} */
  get currentMood() {
    return this._currentMood;
  }

  /**
   * Feed new sensor data. Returns the new mood if a committed switch occurred,
   * or null if the current mood hasn't changed.
   *
   * @param {number} rateLimitedBpm   - Rate-limited BPM from createBpmRateLimiter().
   * @param {number} [pencilVelocity] - Smoothed pencil velocity in px/s (0 if no pencil data).
   * @returns {"calm"|"energetic"|"tense"|null}
   */
  feed(rateLimitedBpm, pencilVelocity = 0) {
    const velBpm = (Math.min(Math.max(0, pencilVelocity), VELOCITY_BONUS_VELOCITY_MAX) /
                   VELOCITY_BONUS_VELOCITY_MAX) * VELOCITY_BONUS_MAX_BPM;
    const effectiveBpm = rateLimitedBpm + velBpm;

    const candidateMood = this._candidateFor(effectiveBpm);

    if (candidateMood === this._currentMood) {
      // Back in current mood territory — cancel any pending switch.
      this._pendingMood = null;
      this._pendingStart = null;
      return null;
    }

    if (candidateMood !== this._pendingMood) {
      // New candidate direction — start the dwell timer.
      this._pendingMood = candidateMood;
      this._pendingStart = Date.now();
      return null; // not yet committed
    }

    // Same candidate as before — check if dwell time has elapsed.
    if (Date.now() - this._pendingStart >= DWELL_MS) {
      const committed = this._pendingMood;
      this._currentMood = committed;
      this._pendingMood = null;
      this._pendingStart = null;
      return committed; // ← caller crossfades to this mood
    }

    return null; // still dwelling, not yet committed
  }

  /**
   * Apply the hysteresis dead-band to determine which mood the signal is
   * currently indicating (may differ from _currentMood until dwell time elapses).
   *
   * @private
   */
  _candidateFor(effectiveBpm) {
    switch (this._currentMood) {
      case "calm":
        // Must reach 80+4 = 84 to cross into ENERGETIC.
        if (effectiveBpm >= BOUNDARY_CALM_ENERGETIC + HYSTERESIS_BPM) return "energetic";
        return "calm";

      case "tense":
        // Must drop below 96−4 = 92 to cross back into ENERGETIC.
        if (effectiveBpm < BOUNDARY_ENERGETIC_TENSE - HYSTERESIS_BPM) return "energetic";
        return "tense";

      case "energetic":
      default:
        if (effectiveBpm < BOUNDARY_CALM_ENERGETIC - HYSTERESIS_BPM)   return "calm";   // < 76
        if (effectiveBpm >= BOUNDARY_ENERGETIC_TENSE + HYSTERESIS_BPM) return "tense";  // ≥ 100
        return "energetic";
    }
  }

  /**
   * Force an immediate mood reset without crossfade scheduling.
   * Used when the system is coming back from static/fallback mode.
   *
   * @param {"calm"|"energetic"|"tense"} mood
   */
  reset(mood = "energetic") {
    this._currentMood = mood;
    this._pendingMood = null;
    this._pendingStart = null;
  }
}
