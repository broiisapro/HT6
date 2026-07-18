import { WebSocketServer } from "ws";
import {
  bpmToPlaybackRate,
  createBpmRateLimiter,
  STALE_TIMEOUT_MS,
} from "./biometric-mapper.js";
import {
  pencilToAudioParams,
  createVelocitySmoother,
  DEFAULT_CUTOFF_HZ,
  DEFAULT_TREMOLO_HZ,
  DEFAULT_PAN,
  STALE_TIMEOUT_MS as PENCIL_STALE_TIMEOUT_MS,
} from "./pencil-mapper.js";
import { MOOD_INVERSE } from "./mood-classifier.js";

const HOST = "0.0.0.0";
const PORT = 8765;

/**
 * Contract WebSocket server (see ../../contracts/README.md).
 *
 * Epic 2 scope: accept connections, log every message.
 * Epic 3: route `type:"biometric"` messages through bpmToPlaybackRate() and
 *   apply the result to sourceNode.playbackRate.value. A stale-data timer
 *   reverts to default tempo if no biometric arrives for STALE_TIMEOUT_MS ms
 *   (see biometric-mapper.js for the documented rationale).
 * Epic 6 (this change): route `type:"pencil"` messages through
 *   pencilToAudioParams() and apply the result to filterNode.frequency,
 *   pannerNode.pan, and lfo.frequency (tremolo rate) — see pencil-mapper.js
 *   for the documented mapping rationale. A separate, shorter stale-data
 *   timer reverts to filter/tremolo/pan defaults if no pencil message
 *   arrives for PENCIL_STALE_TIMEOUT_MS ms.
 * Epic 8: accepts an optional `fallbackPlayer` (FallbackPlayer from
 *   fallback-player.js). When `fallbackPlayer.active` is true:
 *   - incoming live WebSocket messages are logged but not applied, so the
 *     fallback and live inputs don't fight over the same AudioParams.
 *   - stale-timer revert callbacks are suppressed so the fallback's own
 *     playback output is not overwritten.
 *
 * @param {object} [opts]
 * @param {((rate: number) => void)|null} [opts.setPlaybackRate]
 *   Epic 9: function that updates playbackRate on all active stem source nodes.
 * @param {((mood: string, dur?: number) => void)|null} [opts.crossfadeTo]
 *   Epic 9: function that crossfades to a named mood stem.
 * @param {import('./mood-classifier.js').MoodClassifier|null} [opts.classifier]
 *   Epic 9: stateful mood classifier (feeds on rate-limited BPM + pencil velocity).
 * @param {BiquadFilterNode|null} [opts.filterNode] - Epic 6 brightness filter.
 * @param {StereoPannerNode|null} [opts.pannerNode] - Epic 6 stereo pan.
 * @param {OscillatorNode|null} [opts.lfo] - Epic 6 tremolo-rate oscillator.
 * @param {import('./fallback-player.js').FallbackPlayer|null} [opts.fallbackPlayer]
 * @param {{ staticMode: boolean, oppositeMood: boolean }} [opts.liveState]
 *   Epic 8.5: mutable state object toggled by keypress in index.js.
 *   staticMode: freeze ALL parameters (tempo + melody + classification).
 *   oppositeMood: invert mood selection (CALM↔TENSE, ENERGETIC unchanged).
 *   Any omitted/null node means its corresponding messages are still logged but
 *   not applied (safe degraded mode) — lets the server run standalone for testing.
 */
export function startServer({
  setPlaybackRate  = null,
  crossfadeTo      = null,
  classifier       = null,
  filterNode       = null,
  pannerNode       = null,
  lfo              = null,
  fallbackPlayer   = null,
  liveState        = null,
  sessionTracker   = null,   // Epic 9.5: optional, records session stats for portrait
} = {}) {
  // Rate limiter (Epic 8.5): caps BPM change at MAX_BPM_PER_SEC per second
  // so sudden spikes ramp gracefully rather than lurching the tempo.
  const rateLimitBpm = createBpmRateLimiter();

  // Last smoothed pencil velocity — fed into classifier as a secondary signal.
  let lastPencilVelocity = 0;
  const wss = new WebSocketServer({ host: HOST, port: PORT });

  // ── No-data fallback timer ───────────────────────────────────────────────
  // If no biometric message arrives within STALE_TIMEOUT_MS, revert the bed
  // to its native playbackRate = 1.0 (96 BPM) so music keeps playing at a
  // sensible default even when biometrics/ is not running.
  let staleTimer = null;

  function resetStaleTimer() {
    if (staleTimer) clearTimeout(staleTimer);
    staleTimer = setTimeout(() => {
      // Epic 8: suppress revert while fallback is replaying biometric data.
      if (fallbackPlayer?.active) return;
      if (sourceNode) {
        console.log(
          `[tempo] no biometric for ${STALE_TIMEOUT_MS}ms — reverting to default playbackRate=1.0 (96 BPM)`
        );
        sourceNode.playbackRate.value = 1.0;
      }
    }, STALE_TIMEOUT_MS);
  }

  // ── Epic 6: pencil no-data fallback timer ────────────────────────────────
  // Shorter than the biometric timer (see pencil-mapper.js STALE_TIMEOUT_MS
  // doc comment) — pencil streams far more frequently while actively drawing,
  // so a multi-second gap reliably means the performer lifted the Pencil.
  let pencilStaleTimer = null;

  function resetPencilStaleTimer() {
    if (pencilStaleTimer) clearTimeout(pencilStaleTimer);
    pencilStaleTimer = setTimeout(() => {
      // Epic 8: suppress revert while fallback is replaying pencil data.
      if (fallbackPlayer?.active) return;
      console.log(
        `[melody] no pencil for ${PENCIL_STALE_TIMEOUT_MS}ms — reverting to default filter/tremolo/pan`
      );
      if (filterNode) filterNode.frequency.setTargetAtTime(DEFAULT_CUTOFF_HZ, filterNode.context.currentTime, 0.05);
      if (lfo) lfo.frequency.setTargetAtTime(DEFAULT_TREMOLO_HZ, lfo.context.currentTime, 0.05);
      if (pannerNode) pannerNode.pan.setTargetAtTime(DEFAULT_PAN, pannerNode.context.currentTime, 0.05);
    }, PENCIL_STALE_TIMEOUT_MS);
  }

  wss.on("listening", () => {
    console.log(`[server] contract WebSocket server listening on ws://${HOST}:${PORT}`);
    // Arm the stale timers immediately: if biometrics/ or pencil-input/ never
    // start, we fall back to defaults after their respective timeouts rather
    // than leaving whatever last value was set.
    resetStaleTimer();
    resetPencilStaleTimer();
  });

  wss.on("connection", (socket, req) => {
    const remote = req.socket.remoteAddress;
    // Epic 7 (integration fix): smoother is per-connection, not global. A shared
    // EMA carries stale velocity state across reconnects, so the first strokes of a
    // new drawing session blend with the previous session's final velocity —
    // producing incorrect tremolo values. Fresh instance per connection avoids this.
    const smoothVelocity = createVelocitySmoother();
    console.log(`[server] client connected from ${remote}`);

    socket.on("message", (raw) => {
      const rxTime = Date.now(); // latency measurement anchor
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch (err) {
        console.warn(`[server] received non-JSON message from ${remote}: ${raw}`);
        return;
      }

      // Epic 8: while fallback is active, log but do not apply live messages
      // so fallback and live inputs don't fight over the same AudioParams.
      if (fallbackPlayer?.active) {
        console.log(`[server] fallback active — live message dropped from ${remote}:`, message);
        return;
      }

      console.log(`[server] message from ${remote}:`, message);

      if (message.type === "biometric") {
        if (typeof message.bpm !== "number") {
          console.warn("[tempo] biometric message missing numeric bpm field — ignored");
          return;
        }

        // Epic 8.5: rate-limit the incoming BPM before mapping or classifying.
        const rateLimited = rateLimitBpm(message.bpm);

        // Epic 8.5 — static mode: freeze all parameter changes.
        if (liveState?.staticMode) {
          console.log(`[tempo] STATIC MODE — biometric ignored (heart=${message.bpm.toFixed(1)} BPM)`);
          resetStaleTimer();
          return;
        }

        if (setPlaybackRate) {
          const rate = bpmToPlaybackRate(rateLimited);
          setPlaybackRate(rate);
          const applyTime = Date.now();
          const transitLatency = typeof message.timestamp === "number"
            ? rxTime - message.timestamp
            : null;
          console.log(
            `[tempo] heart=${message.bpm.toFixed(1)} BPM` +
            ` → rateLimited=${rateLimited.toFixed(1)} BPM → playbackRate=${rate.toFixed(4)}` +
            ` | transit_latency=${transitLatency !== null ? transitLatency + "ms" : "n/a"}` +
            ` | apply_latency=${applyTime - rxTime}ms` +
            ` | msg_ts=${message.timestamp}`
          );
        } else {
          console.log(`[tempo] biometric received but no setPlaybackRate — heart=${message.bpm} BPM (no-op)`);
        }

        // Epic 9.5: record BPM in session tracker (after rate-limiting).
        sessionTracker?.recordBpm(rateLimited);

        // Epic 9: run the classifier and crossfade if mood changed.
        if (classifier && crossfadeTo) {
          const newMood = classifier.feed(rateLimited, lastPencilVelocity);
          if (newMood) {
            // Epic 9.5: record the mood change in the session tracker.
            sessionTracker?.recordMood(newMood);

            // Epic 9.5 panic mode: classifier still advances for tracking,
            // but crossfade is suppressed while panic overrides the stem.
            if (!liveState?.panicMode) {
              // Epic 8.5 opposite-mood: invert selection (CALM↔TENSE, ENERGETIC unchanged).
              const stem = liveState?.oppositeMood ? MOOD_INVERSE[newMood] : newMood;
              console.log(
                `[mood] classified=${newMood}` +
                `${liveState?.oppositeMood ? ` → inverted=${stem}` : ""}` +
                ` | bpm=${rateLimited.toFixed(1)} vel=${lastPencilVelocity.toFixed(0)}px/s`
              );
              crossfadeTo(stem);
            } else {
              console.log(
                `[mood] PANIC MODE — classifier advanced to ${newMood} but crossfade suppressed`
              );
            }
          }
        }

        resetStaleTimer();
      }

      if (message.type === "pencil") {
        if (
          typeof message.x !== "number" ||
          typeof message.velocity !== "number" ||
          (message.tilt !== null && typeof message.tilt !== "number")
        ) {
          console.warn("[melody] pencil message missing required numeric fields — ignored");
          return;
        }

        const velocity = smoothVelocity(message.velocity);
        // Epic 9: store the latest smoothed velocity for the classifier.
        lastPencilVelocity = velocity;
        // Epic 9.5: record pencil activity for session portrait.
        sessionTracker?.recordPencil(velocity);

        // Epic 8.5 — static mode: freeze melody parameters too.
        if (liveState?.staticMode) {
          console.log(`[melody] STATIC MODE — pencil ignored`);
          resetPencilStaleTimer();
          return;
        }

        const { cutoffHz, tremoloHz, pan } = pencilToAudioParams({
          x: message.x,
          velocity,
          tilt: message.tilt,
        });

        if (filterNode || pannerNode || lfo) {
          // setTargetAtTime (not a direct .value assignment) avoids audible
          // zipper noise from instantaneous AudioParam jumps at ~30 msg/s.
          const now = (filterNode || pannerNode || lfo).context.currentTime;
          if (filterNode) filterNode.frequency.setTargetAtTime(cutoffHz, now, 0.05);
          if (pannerNode) pannerNode.pan.setTargetAtTime(pan, now, 0.05);
          if (lfo) lfo.frequency.setTargetAtTime(tremoloHz, now, 0.05);
          const applyTime = Date.now();
          const transitLatency = typeof message.timestamp === "number"
            ? rxTime - message.timestamp
            : null;
          console.log(
            `[melody] tilt=${message.tilt === null ? "null" : message.tilt.toFixed(1)}` +
            ` velocity=${velocity.toFixed(0)}px/s x=${message.x.toFixed(0)}` +
            ` → cutoff=${cutoffHz.toFixed(0)}Hz tremolo=${tremoloHz.toFixed(2)}Hz pan=${pan.toFixed(2)}` +
            ` | transit_latency=${transitLatency !== null ? transitLatency + "ms" : "n/a"}` +
            ` | apply_latency=${applyTime - rxTime}ms`
          );
        } else {
          console.log(`[melody] pencil received but no audio nodes — (no-op)`);
        }
        resetPencilStaleTimer();
      }
    });

    socket.on("close", () => {
      console.log(`[server] client disconnected: ${remote}`);
    });

    socket.on("error", (err) => {
      console.error(`[server] socket error from ${remote}:`, err.message);
    });
  });

  wss.on("error", (err) => {
    console.error("[server] server error:", err.message);
  });

  return wss;
}
