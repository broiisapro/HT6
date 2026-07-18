import { WebSocketServer } from "ws";
import { bpmToPlaybackRate, STALE_TIMEOUT_MS } from "./biometric-mapper.js";
import {
  pencilToAudioParams,
  createVelocitySmoother,
  DEFAULT_CUTOFF_HZ,
  DEFAULT_TREMOLO_HZ,
  DEFAULT_PAN,
  STALE_TIMEOUT_MS as PENCIL_STALE_TIMEOUT_MS,
} from "./pencil-mapper.js";

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
 *
 * @param {object} [opts]
 * @param {AudioBufferSourceNode|null} [opts.sourceNode] - The looping bed source.
 * @param {BiquadFilterNode|null} [opts.filterNode] - Epic 6 brightness filter.
 * @param {StereoPannerNode|null} [opts.pannerNode] - Epic 6 stereo pan.
 * @param {OscillatorNode|null} [opts.lfo] - Epic 6 tremolo-rate oscillator.
 *   All four are returned by startPlayback(). Any omitted/null node means
 *   its corresponding messages are still logged but not applied (safe
 *   degraded mode) — lets the server run standalone for testing.
 */
export function startServer({
  sourceNode = null,
  filterNode = null,
  pannerNode = null,
  lfo = null,
} = {}) {
  const wss = new WebSocketServer({ host: HOST, port: PORT });
  const smoothVelocity = createVelocitySmoother();

  // ── No-data fallback timer ───────────────────────────────────────────────
  // If no biometric message arrives within STALE_TIMEOUT_MS, revert the bed
  // to its native playbackRate = 1.0 (96 BPM) so music keeps playing at a
  // sensible default even when biometrics/ is not running.
  let staleTimer = null;

  function resetStaleTimer() {
    if (staleTimer) clearTimeout(staleTimer);
    staleTimer = setTimeout(() => {
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

      console.log(`[server] message from ${remote}:`, message);

      if (message.type === "biometric") {
        if (typeof message.bpm !== "number") {
          console.warn("[tempo] biometric message missing numeric bpm field — ignored");
          return;
        }
        if (sourceNode) {
          const rate = bpmToPlaybackRate(message.bpm);
          sourceNode.playbackRate.value = rate;
          const applyTime = Date.now();
          // Log latency fields:
          //   transit_latency = rxTime - message.timestamp
          //     The round-trip from the biometrics pipeline's Date.now() at
          //     emit time to the server's Date.now() at message receipt.
          //     Both processes are on the same Mac; this measures WebSocket
          //     framing + loopback TCP + Node event-loop scheduling overhead.
          //   apply_latency = applyTime - rxTime
          //     Internal parse + mapping time only (sub-ms in practice).
          const transitLatency = typeof message.timestamp === "number"
            ? rxTime - message.timestamp
            : null;
          console.log(
            `[tempo] heart=${message.bpm.toFixed(1)} BPM` +
            ` → playbackRate=${rate.toFixed(4)}` +
            ` | transit_latency=${transitLatency !== null ? transitLatency + "ms" : "n/a"}` +
            ` | apply_latency=${applyTime - rxTime}ms` +
            ` | msg_ts=${message.timestamp}`
          );
        } else {
          console.log(`[tempo] biometric received but no sourceNode — heart=${message.bpm} BPM (no-op)`);
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
