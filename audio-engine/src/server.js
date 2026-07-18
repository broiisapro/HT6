import { WebSocketServer } from "ws";
import { bpmToPlaybackRate, STALE_TIMEOUT_MS } from "./biometric-mapper.js";

const HOST = "0.0.0.0";
const PORT = 8765;

/**
 * Contract WebSocket server (see ../../contracts/README.md).
 *
 * Epic 2 scope: accept connections, log every message.
 * Epic 3 (this change): route `type:"biometric"` messages through
 *   bpmToPlaybackRate() and apply the result to sourceNode.playbackRate.value.
 *   A stale-data timer reverts to default tempo if no biometric arrives for
 *   STALE_TIMEOUT_MS ms (see biometric-mapper.js for the documented rationale).
 * Epic 6 hook: add `if (message.type === "pencil") { ... }` in the message
 *   handler below and drive melody/timbre from there.
 *
 * @param {object} [opts]
 * @param {AudioBufferSourceNode|null} [opts.sourceNode] - The looping bed source.
 *   Pass the value returned by startPlayback(). If omitted or null, biometric
 *   messages are still logged but playbackRate is not changed (safe degraded mode).
 */
export function startServer({ sourceNode = null } = {}) {
  const wss = new WebSocketServer({ host: HOST, port: PORT });

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

  wss.on("listening", () => {
    console.log(`[server] contract WebSocket server listening on ws://${HOST}:${PORT}`);
    // Arm the stale timer immediately: if biometrics/ never starts, we fall
    // back to default tempo after STALE_TIMEOUT_MS rather than leaving whatever
    // last playbackRate was set.
    resetStaleTimer();
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
      // Epic 6: if (message.type === "pencil") { ... drive melody/timbre ... }
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
