/**
 * biometric-zone-mapper.js — Epic 9: Zone-based mood mapping
 *
 * Maps a heart-rate BPM to one of four mood zones, with three performer-
 * selectable intention strategies:
 *
 *   match_my_energy — direct 1:1 mapping (the default). Each of the four
 *     zones spans an equal 20-BPM window across the 50–130 BPM range.
 *
 *   calm_me_down — resists elevated heart rates; makes it much harder to
 *     reach the energetic zones and easier to stay in calm/focused.
 *
 *   lift_my_energy — accelerates zone progression; the performer reaches
 *     energised and dreamy at lower heart rates than the default.
 *
 * All three strategies route through the same dwell-time hysteresis
 * (createZoneTracker) so zone flips are debounced identically regardless of
 * which bands are in use.
 *
 * ── match_my_energy (ZONE_BANDS) ─────────────────────────────────────────────
 * Direct linear mapping: four equal 20-BPM slots across [50, 130].
 *   calm:      50– 70 BPM
 *   focused:   70– 90 BPM
 *   dreamy:    90–110 BPM
 *   energised: 110–130 BPM
 *
 * ── calm_me_down (CALM_ME_DOWN_BANDS) ────────────────────────────────────────
 * Strategy: shift all zone boundaries UP by ~15 BPM relative to the default.
 * A performer with an elevated heart rate fights the mapping rather than
 * mirroring it — the system actively steers toward calm/focused output.
 *
 * Design: shift implemented as separate band thresholds (not a subtractive
 * bias applied before classification). This avoids clamping edge cases and
 * keeps each strategy self-contained and independently testable.
 *
 *   calm:      50– 85 BPM  (35 BPM wide — easy to reach and stay in)
 *   focused:   85–105 BPM  (20 BPM)
 *   dreamy:   105–120 BPM  (15 BPM)
 *   energised: 120–130 BPM (10 BPM — near-unreachable at typical demo HR)
 *
 * Concrete contrast vs match_my_energy:
 *   BPM  80 → match_my_energy: focused  | calm_me_down: calm
 *   BPM 100 → match_my_energy: dreamy   | calm_me_down: focused
 *   BPM 115 → match_my_energy: energised| calm_me_down: dreamy
 *
 * ── lift_my_energy (LIFT_ME_UP_BANDS) ────────────────────────────────────────
 * Strategy: shift all zone boundaries DOWN by ~12–15 BPM relative to default.
 * Even a lightly elevated heart rate pushes into dreamy/energised territory —
 * the system lifts the mood early and keeps it there.
 *
 *   calm:      50– 62 BPM  (12 BPM — graduated out of quickly)
 *   focused:   62– 77 BPM  (15 BPM)
 *   dreamy:    77– 95 BPM  (18 BPM)
 *   energised:  95–130 BPM (35 BPM wide — easy to reach and sustain)
 *
 * Concrete contrast vs match_my_energy:
 *   BPM  65 → match_my_energy: calm     | lift_my_energy: focused
 *   BPM  80 → match_my_energy: focused  | lift_my_energy: dreamy
 *   BPM  95 → match_my_energy: dreamy   | lift_my_energy: energised
 *
 * ── Tempo nudge ───────────────────────────────────────────────────────────────
 * bpmToPlaybackRateWithinZone() provides a continuous ±8% tempo nudge within
 * the active zone. At the zone's low edge the bed plays at 8% below the zone
 * center; at the high edge, 8% above. Used in static mode (where zone never
 * changes) so the performer still hears tempo variation without mood shifts.
 */

import { BED_BPM } from "./biometric-mapper.js";

export { BED_BPM };

/** Minimum milliseconds a candidate zone must persist before confirming a switch. */
export const MIN_DWELL_MS = 4000;

// ── Zone band tables ────────────────────────────────────────────────────────

/**
 * match_my_energy: four equal 20-BPM zones across [50, 130].
 * This is the default strategy; classifyZone() uses this table by default.
 */
export const ZONE_BANDS = {
  calm:      { low: 50,  high: 70,  center: 60  },
  focused:   { low: 70,  high: 90,  center: 80  },
  dreamy:    { low: 90,  high: 110, center: 100 },
  energised: { low: 110, high: 130, center: 120 },
};

/**
 * calm_me_down: shifted thresholds resist energetic zone entry.
 * calm gets a wide 35-BPM window; energised is compressed to 10 BPM.
 * See module doc for full reasoning.
 */
export const CALM_ME_DOWN_BANDS = {
  calm:      { low: 50,  high: 85,  center: 67  },
  focused:   { low: 85,  high: 105, center: 95  },
  dreamy:    { low: 105, high: 120, center: 112 },
  energised: { low: 120, high: 130, center: 125 },
};

/**
 * lift_my_energy: shifted thresholds encourage energetic zone entry.
 * energised gets a wide 35-BPM window; calm is compressed to 12 BPM.
 * See module doc for full reasoning.
 */
export const LIFT_ME_UP_BANDS = {
  calm:      { low: 50,  high: 62,  center: 56  },
  focused:   { low: 62,  high: 77,  center: 69  },
  dreamy:    { low: 77,  high: 95,  center: 86  },
  energised: { low: 95,  high: 130, center: 112 },
};

/**
 * Map of intention name → its band table.
 * Used by server.js to look up the right table from the active intention string.
 */
export const INTENTION_BANDS = {
  match_my_energy: ZONE_BANDS,
  calm_me_down:    CALM_ME_DOWN_BANDS,
  lift_my_energy:  LIFT_ME_UP_BANDS,
};

// ── Classification ──────────────────────────────────────────────────────────

/**
 * Classify a BPM value into a zone name using the given band table.
 *
 * Uses half-open intervals [low, high): a BPM exactly at a boundary (e.g.
 * 70 BPM in ZONE_BANDS) goes to the HIGHER zone (focused, not calm). BPM
 * above all bands clamps to the highest zone.
 *
 * @param {number} bpm   - Effective BPM (already clamped by biometric-mapper).
 * @param {object} [bands=ZONE_BANDS] - One of the INTENTION_BANDS values.
 * @returns {string} Zone name ("calm" | "focused" | "dreamy" | "energised").
 */
export function classifyZone(bpm, bands = ZONE_BANDS) {
  // Sort entries ascending by low threshold — ensures correct order regardless
  // of insertion order in the band table object.
  const sorted = Object.entries(bands).sort(([, a], [, b]) => a.low - b.low);
  for (const [zone, { high }] of sorted) {
    if (bpm < high) return zone;
  }
  // BPM at or above the last zone's high → clamp to last zone.
  return sorted[sorted.length - 1][0];
}

// ── Zone tracker (dwell hysteresis) ────────────────────────────────────────

/**
 * Create a zone tracker that debounces zone switches via a dwell window.
 *
 * A candidate zone must persist continuously for at least minDwellMs before
 * the tracker confirms the switch. A BPM value oscillating around a boundary
 * (e.g. 89–91 BPM near the focused/dreamy edge) will NOT jitter the zone.
 *
 * First update() call confirms immediately (no prior zone to protect).
 *
 * Manual mode/zone selections (from type:"mode" WS messages) bypass this
 * tracker entirely — use forceZone() for those. The dwell window exists to
 * smooth noisy sensor data; a deliberate UI input is not noisy data.
 *
 * @param {number} [minDwellMs=MIN_DWELL_MS] - Dwell window in milliseconds.
 * @returns {{ update, getZone, forceZone }}
 */
export function createZoneTracker(minDwellMs = MIN_DWELL_MS) {
  let confirmedZone = null;
  let pendingZone   = null;
  let pendingStartMs = null;

  /**
   * Advance the tracker with a new candidate zone.
   * @param {string} candidateZone
   * @param {number} [nowMs=Date.now()]
   * @returns {{ zone: string, switched: boolean }}
   */
  function update(candidateZone, nowMs = Date.now()) {
    // First update: no prior zone — confirm immediately.
    if (confirmedZone === null) {
      confirmedZone = candidateZone;
      pendingZone   = null;
      pendingStartMs = null;
      return { zone: confirmedZone, switched: true };
    }

    // Candidate matches confirmed — cancel any pending switch.
    if (candidateZone === confirmedZone) {
      pendingZone   = null;
      pendingStartMs = null;
      return { zone: confirmedZone, switched: false };
    }

    // Candidate differs from confirmed — start or continue pending dwell.
    if (candidateZone !== pendingZone) {
      // New pending candidate (was in a different pending zone before, or
      // no pending was active). Restart the dwell timer.
      pendingZone    = candidateZone;
      pendingStartMs = nowMs;
    }

    if (nowMs - pendingStartMs >= minDwellMs) {
      // Dwell elapsed — confirm the switch.
      confirmedZone  = pendingZone;
      pendingZone    = null;
      pendingStartMs = null;
      return { zone: confirmedZone, switched: true };
    }

    // Still within dwell window — hold current confirmed zone.
    return { zone: confirmedZone, switched: false };
  }

  /** Return the currently confirmed zone (null before first update). */
  function getZone() { return confirmedZone; }

  /**
   * Immediately force-set the confirmed zone, bypassing dwell.
   * Used for manual mode/zone selections from the UI (type:"mode" messages).
   * @param {string} zone
   */
  function forceZone(zone) {
    confirmedZone  = zone;
    pendingZone    = null;
    pendingStartMs = null;
  }

  return { update, getZone, forceZone };
}

// ── Tempo nudge within zone ─────────────────────────────────────────────────

/**
 * Compute the playback rate for a ±8% tempo nudge within the active zone.
 *
 * The zone's center BPM plays at exactly (center / BED_BPM). Within [low, high]
 * the rate interpolates ±8% around that center value, giving the performer a
 * subtle tempo variation that mirrors their heart rate without switching zones.
 *
 * BPM outside [low, high] is clamped to the zone boundary, so the nudge
 * saturates at ±8% — it cannot push the tempo outside the zone's range.
 *
 * Used in static mode, where the zone is pinned and the performer hears tempo
 * variation without any mood shift.
 *
 * @param {number} bpm      - Effective BPM (post clamp/rate-limit).
 * @param {string} zoneName - One of the four zone names.
 * @param {object} [bands=ZONE_BANDS] - Band table to look up the zone's range.
 * @returns {number} playbackRate to set on AudioBufferSourceNode.
 */
export function bpmToPlaybackRateWithinZone(bpm, zoneName, bands = ZONE_BANDS) {
  const { low, high, center } = bands[zoneName];
  const clamped = Math.max(low, Math.min(high, bpm));
  const pos     = (clamped - low) / (high - low);  // 0..1 within zone
  const nudge   = 0.92 + pos * 0.16;               // 0.92..1.08 (±8%)
  return (center / BED_BPM) * nudge;
}
