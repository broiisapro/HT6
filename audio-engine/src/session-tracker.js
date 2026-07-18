/**
 * session-tracker.js — Epic 9.5: Performance Portrait data collection
 *
 * Passively collects performance statistics throughout a live session:
 * BPM range, mood distribution, pencil activity, and panic triggers.
 * Used by portrait-generator.js to build the fal.ai portrait prompt
 * after the performance ends.
 *
 * Designed to be zero-overhead in the hot path — all operations are
 * simple accumulations, no async I/O, no allocations per message.
 */

export class SessionTracker {
  constructor() {
    this._startTime  = Date.now();
    this._bpmMin     = Infinity;
    this._bpmMax     = -Infinity;
    /** @type {{calm:number, energetic:number, tense:number}} ms spent in each mood */
    this._moodMs     = { calm: 0, energetic: 0, tense: 0 };
    this._lastMood   = "energetic"; // default (matches MoodClassifier default)
    this._lastMoodTs = Date.now();
    this._pencilMsgCount   = 0;
    this._pencilVelSum     = 0;
    this._strokeCount      = 0;   // increments when velocity resets near zero
    this._prevVelocity     = null;
    this._panicCount       = 0;
    this._finalized        = false;
  }

  /** Called with every rate-limited BPM value (after createBpmRateLimiter). */
  recordBpm(bpm) {
    if (this._finalized) return;
    if (bpm < this._bpmMin) this._bpmMin = bpm;
    if (bpm > this._bpmMax) this._bpmMax = bpm;
  }

  /** Called when the classifier commits to a new mood. */
  recordMood(newMood) {
    if (this._finalized) return;
    const now = Date.now();
    this._moodMs[this._lastMood] += now - this._lastMoodTs;
    this._lastMood   = newMood;
    this._lastMoodTs = now;
  }

  /** Called with smoothed pencil velocity from each pencil message. */
  recordPencil(velocity) {
    if (this._finalized) return;
    this._pencilMsgCount++;
    this._pencilVelSum += velocity;
    // Detect stroke start: velocity drops near zero then rises again
    if (this._prevVelocity !== null && this._prevVelocity < 15 && velocity >= 15) {
      this._strokeCount++;
    }
    this._prevVelocity = velocity;
  }

  /** Called each time panic mode is activated. */
  recordPanic() {
    if (this._finalized) return;
    this._panicCount++;
  }

  /**
   * Freeze the tracker and return the final session data object.
   * Safe to call multiple times — only finalizes once.
   *
   * @returns {SessionData}
   */
  finalize() {
    if (!this._finalized) {
      this._finalized = true;
      this._moodMs[this._lastMood] += Date.now() - this._lastMoodTs;
    }
    return this.getSessionData();
  }

  /** @returns {SessionData} - current (non-final) snapshot */
  getSessionData() {
    const totalMoodMs = Object.values(this._moodMs).reduce((a, b) => a + b, 0) || 1;
    return {
      durationMs:  Date.now() - this._startTime,
      bpmMin:      this._bpmMin  === Infinity  ? 80 : Math.round(this._bpmMin  * 10) / 10,
      bpmMax:      this._bpmMax  === -Infinity ? 80 : Math.round(this._bpmMax  * 10) / 10,
      moodPercent: {
        calm:      Math.round(100 * this._moodMs.calm      / totalMoodMs),
        energetic: Math.round(100 * this._moodMs.energetic / totalMoodMs),
        tense:     Math.round(100 * this._moodMs.tense     / totalMoodMs),
      },
      avgVelocityPxs: this._pencilMsgCount > 0
        ? Math.round(this._pencilVelSum / this._pencilMsgCount)
        : 0,
      strokeCount: this._strokeCount,
      panicCount:  this._panicCount,
    };
  }
}

/**
 * @typedef {object} SessionData
 * @property {number} durationMs
 * @property {number} bpmMin
 * @property {number} bpmMax
 * @property {{calm:number, energetic:number, tense:number}} moodPercent
 * @property {number} avgVelocityPxs
 * @property {number} strokeCount
 * @property {number} panicCount
 */
