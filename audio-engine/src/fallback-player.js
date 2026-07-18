/**
 * fallback-player.js — Epic 8: Demo Rehearsal & Fallbacks
 *
 * Replays pre-recorded biometric and pencil message sequences when live
 * hardware input is unavailable (Bluetooth drop, camera failure, network
 * hiccup) so the demo can continue without visible interruption.
 *
 * ── Trigger ─────────────────────────────────────────────────────────────────
 * Activated/deactivated from index.js via the `f` keypress in the terminal
 * running `npm start`. A second `f` press returns to live input.
 *
 * ── Data files ───────────────────────────────────────────────────────────────
 * audio-engine/assets/fallback-biometric.json — 60 msgs, 1 s intervals,
 *   arc 75→97.6→82 BPM (modelled on real Polar Vantage M Epic 1 data).
 *   Loops indefinitely until deactivated.
 *
 * audio-engine/assets/fallback-pencil.json — 3 strokes with inter-stroke
 *   gaps (~3.7 s per loop):
 *     Stroke 1: gentle left-to-right, tilt 22.5° (medium brightness)
 *     Stroke 2: fast right-to-left diagonal, tilt 38° (bright, high tremolo)
 *     Stroke 3: slow upward centre, tilt 11° (dark, low tremolo)
 *   Gap entries (type: "gap") revert melody params to defaults and wait
 *   the specified interval_ms before the next stroke begins.
 *
 * ── Interaction with server.js stale timers ─────────────────────────────────
 * When fallback is active, server.js's stale-timer callbacks check
 * `fallbackPlayer.active` before reverting audio params — they skip the
 * revert so the fallback's own output isn't overwritten. When fallback is
 * deactivated, the stale timers resume normal behaviour: after 8 s (biometric)
 * or 2 s (pencil) without live input the params revert to their defaults
 * automatically, giving the performer time to restart live sources.
 *
 * ── Interaction with server.js message handler ───────────────────────────────
 * While fallback is active, incoming live WebSocket messages are dropped in
 * server.js (logged but not applied) so live and fallback don't fight over
 * the same AudioParams.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { bpmToPlaybackRate } from "./biometric-mapper.js";
import {
  pencilToAudioParams,
  createVelocitySmoother,
  DEFAULT_CUTOFF_HZ,
  DEFAULT_TREMOLO_HZ,
  DEFAULT_PAN,
} from "./pencil-mapper.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load data at module init — these are small JSON files committed to the repo.
const biometricMessages = JSON.parse(
  readFileSync(path.join(__dirname, "..", "assets", "fallback-biometric.json"), "utf8")
);
const pencilMessages = JSON.parse(
  readFileSync(path.join(__dirname, "..", "assets", "fallback-pencil.json"), "utf8")
);

export class FallbackPlayer {
  /**
   * @param {object} nodes
   * @param {AudioBufferSourceNode|null} nodes.sourceNode
   * @param {BiquadFilterNode|null}      nodes.filterNode
   * @param {StereoPannerNode|null}      nodes.pannerNode
   * @param {OscillatorNode|null}        nodes.lfo
   *
   * Any node passed as null → that audio parameter is still not touched,
   * matching the degraded-mode contract in server.js.
   */
  constructor({ sourceNode = null, filterNode = null, pannerNode = null, lfo = null } = {}) {
    this._sourceNode = sourceNode;
    this._filterNode = filterNode;
    this._pannerNode = pannerNode;
    this._lfo = lfo;

    this._active = false;
    this._bioIdx = 0;
    this._pencilIdx = 0;
    this._bioTimeout = null;
    this._pencilTimeout = null;
    this._smoothVelocity = createVelocitySmoother();
  }

  /** True while fallback playback is running. */
  get active() {
    return this._active;
  }

  /**
   * Activate fallback. Starts replaying both sequences from the beginning.
   * No-op if already active.
   */
  start() {
    if (this._active) return;
    this._active = true;
    this._bioIdx = 0;
    this._pencilIdx = 0;
    this._smoothVelocity = createVelocitySmoother(); // fresh EMA per activation
    console.log(
      "[fallback] ACTIVATED — replaying pre-recorded sequences." +
      " Press f again to return to live input."
    );
    this._scheduleBio();
    this._schedulePencil();
  }

  /**
   * Deactivate fallback. Clears both replay loops.
   * The server.js stale timers will then revert audio params to defaults after
   * their normal timeouts (8 s biometric / 2 s pencil) if no live data resumes.
   */
  stop() {
    if (!this._active) return;
    this._active = false;
    if (this._bioTimeout)    { clearTimeout(this._bioTimeout);    this._bioTimeout    = null; }
    if (this._pencilTimeout) { clearTimeout(this._pencilTimeout); this._pencilTimeout = null; }
    console.log(
      "[fallback] DEACTIVATED — returning to live input." +
      " Stale timers will revert audio params within 8 s (tempo) / 2 s (melody) if no live data resumes."
    );
  }

  // ── Private replay loops ──────────────────────────────────────────────────

  _scheduleBio() {
    if (!this._active) return;
    const msg = biometricMessages[this._bioIdx % biometricMessages.length];
    this._applyBio(msg.bpm);
    const delay = msg.interval_ms ?? 1000;
    this._bioIdx++;
    this._bioTimeout = setTimeout(() => this._scheduleBio(), delay);
  }

  _schedulePencil() {
    if (!this._active) return;
    const msg = pencilMessages[this._pencilIdx % pencilMessages.length];

    if (msg.type === "gap") {
      // Simulate Pencil lift: revert melody params to defaults so the gap
      // sounds like a silence/reset rather than a frozen last-stroke state.
      this._revertMelodyToDefaults();
      console.log("[fallback/melody] gap — reverted to defaults");
    } else {
      this._applyPencil(msg);
    }

    const delay = msg.interval_ms ?? 33;
    this._pencilIdx++;
    this._pencilTimeout = setTimeout(() => this._schedulePencil(), delay);
  }

  _applyBio(bpm) {
    if (!this._sourceNode) return;
    const rate = bpmToPlaybackRate(bpm);
    this._sourceNode.playbackRate.value = rate;
    console.log(
      `[fallback/tempo] bpm=${bpm.toFixed(1)} → playbackRate=${rate.toFixed(4)}`
    );
  }

  _applyPencil(msg) {
    const f = this._filterNode;
    const p = this._pannerNode;
    const l = this._lfo;
    if (!f && !p && !l) return;

    const velocity = this._smoothVelocity(msg.velocity);
    const { cutoffHz, tremoloHz, pan } = pencilToAudioParams({
      x: msg.x,
      velocity,
      tilt: msg.tilt,
    });

    const ctx = (f || p || l).context;
    const now = ctx.currentTime;
    if (f) f.frequency.setTargetAtTime(cutoffHz, now, 0.05);
    if (p) p.pan.setTargetAtTime(pan, now, 0.05);
    if (l) l.frequency.setTargetAtTime(tremoloHz, now, 0.05);

    console.log(
      `[fallback/melody] tilt=${msg.tilt === null ? "null" : msg.tilt.toFixed(1)}` +
      ` vel=${velocity.toFixed(0)}px/s x=${msg.x.toFixed(0)}` +
      ` → cutoff=${cutoffHz.toFixed(0)}Hz tremolo=${tremoloHz.toFixed(2)}Hz pan=${pan.toFixed(2)}`
    );
  }

  _revertMelodyToDefaults() {
    const f = this._filterNode;
    const p = this._pannerNode;
    const l = this._lfo;
    if (!f && !p && !l) return;
    const ctx = (f || p || l).context;
    const now = ctx.currentTime;
    if (f) f.frequency.setTargetAtTime(DEFAULT_CUTOFF_HZ, now, 0.05);
    if (p) p.pan.setTargetAtTime(DEFAULT_PAN, now, 0.05);
    if (l) l.frequency.setTargetAtTime(DEFAULT_TREMOLO_HZ, now, 0.05);
  }
}
