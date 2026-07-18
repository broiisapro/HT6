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
 *   reverts to default tempo if no biometric arrives for STALE_TIMEOUT_MS ms.
 * Epic 6: route `type:"pencil"` messages through pencilToAudioParams() and
 *   apply to filterNode.frequency, pannerNode.pan, lfo.frequency.
 * Epic 8: accepts an optional `fallbackPlayer`. When active, live WS messages
 *   are logged but not applied.
 * Epic 8.5: rate-of-change limiting always on; staticMode and oppositeMood
 *   toggled via liveState object from index.js.
 * Epic 9: accepts setPlaybackRate / crossfadeTo / classifier for multi-stem
 *   crossfade driven by mood classification.
 *
 * @param {object} [opts]
 * @param {((rate: number) => void)|null} [opts.setPlaybackRate]
 * @param {((mood: string, dur?: number) => void)|null} [opts.crossfadeTo]
 * @param {import('./mood-classifier.js').MoodClassifier|null} [opts.classifier]
 * @param {BiquadFilterNode|null} [opts.filterNode]
 * @param {StereoPannerNode|null} [opts.pannerNode]
 * @param {OscillatorNode|null} [opts.lfo]
 * @param {import('./fallback-player.js').FallbackPlayer|null} [opts.fallbackPlayer]
 * @param {{ staticMode: boolean, oppositeMood: boolean, panicMode: boolean }} [opts.liveState]
 */
export function startServer({
  setPlaybackRate = null,
  crossfadeTo     = null,
  classifier      = null,
  filterNode      = null,
  pannerNode      = null,
  lfo             = null,
  fallbackPlayer  = null,
  liveState       = null,
} = {}) {
  // Rate limiter (Epic 8.5): caps BPM change at MAX_BPM_PER_SEC per second.
  const rateLimitBpm = createBpmRateLimiter();

  // Last smoothed pencil velocity — fed into classifier as secondary signal.
  let lastPencilVelocity = 0;

  const wss = new WebSocketServer({ host: HOST, port: PORT });

  // ── No-data fallback timer ───────────────────────────────────────────────
  let staleTimer = null;

  function resetStaleTimer() {
    if (staleTimer) clearTimeout(staleTimer);
    staleTimer = setTimeout(() => {
      if (fallbackPlayer?.active) return;
      if (setPlaybackRate) {
        console.log(
          `[tempo] no biometric for ${STALE_TIMEOUT_MS}ms — reverting to default playbackRate=1.0 (96 BPM)`
        );
        setPlaybackRate(1.0);
      }
    }, STALE_TIMEOUT_MS);
  }

  // ── Pencil no-data fallback timer ────────────────────────────────────────
  let pencilStaleTimer = null;

  function resetPencilStaleTimer() {
    if (pencilStaleTimer) clearTimeout(pencilStaleTimer);
    pencilStaleTimer = setTimeout(() => {
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
    resetStaleTimer();
    resetPencilStaleTimer();
  });

  wss.on("connection", (socket, req) => {
    const remote = req.socket.remoteAddress;
    const smoothVelocity = createVelocitySmoother();
    console.log(`[server] client connected from ${remote}`);

    socket.on("message", (raw) => {
      const rxTime = Date.now();
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch (err) {
        console.warn(`[server] received non-JSON message from ${remote}: ${raw}`);
        return;
      }

      // Epic 8: while fallback is active, log but do not apply live messages.
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

        // Epic 9: run the classifier and crossfade if mood changed.
        // Crossfade is suppressed during panicMode (index.js owns that stem).
        if (classifier && crossfadeTo && !liveState?.panicMode) {
          const newMood = classifier.feed(rateLimited, lastPencilVelocity);
          if (newMood) {
            const stem = liveState?.oppositeMood ? MOOD_INVERSE[newMood] : newMood;
            console.log(
              `[mood] classified=${newMood}` +
              `${liveState?.oppositeMood ? ` → inverted=${stem}` : ""}` +
              ` | bpm=${rateLimited.toFixed(1)} vel=${lastPencilVelocity.toFixed(0)}px/s`
            );
            crossfadeTo(stem);
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

        resetPencilStaleTimer();

        const velocity = smoothVelocity(message.velocity);
        // Epic 9: store latest smoothed velocity for the classifier.
        lastPencilVelocity = velocity;

        // Epic 8.5 — static mode: freeze melody parameters too.
        if (liveState?.staticMode) {
          console.log(`[melody] STATIC MODE — pencil ignored`);
          return;
        }

        const { cutoffHz, tremoloHz, pan } = pencilToAudioParams({
          x: message.x,
          velocity,
          tilt: message.tilt,
        });

        if (filterNode || pannerNode || lfo) {
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

  return { wss };
}
