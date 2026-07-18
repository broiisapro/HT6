import { WebSocketServer } from "ws";
import {
  createZoneTracker,
  bpmToPlaybackRateWithinZone,
  STALE_TIMEOUT_MS,
} from "./biometric-zone-mapper.js";
import {
  pencilToAudioParams,
  createVelocitySmoother,
  STALE_TIMEOUT_MS as PENCIL_STALE_TIMEOUT_MS,
} from "./pencil-mapper.js";

const HOST = "0.0.0.0";
const PORT = 8765;

/**
 * Contract WebSocket server (see ../../contracts/README.md).
 *
 * Epic 3 (mood-zone version): route `type:"biometric"` messages through
 *   createZoneTracker() (bpm -> zone, debounced) and
 *   bpmToPlaybackRateWithinZone() (continuous nudge within that zone), and
 *   apply via playback.switchBed()/setTempo(). A stale-data timer resets
 *   tempo to the neutral rate (1.0) if no biometric arrives for
 *   STALE_TIMEOUT_MS — it deliberately does NOT revert the zone itself,
 *   since falling back to a default zone on a brief gap would be a jarring,
 *   unmotivated crossfade; the zone just stays wherever it last settled.
 * Epic 6: route `type:"pencil"` messages through pencilToAudioParams() and
 *   apply via playback.setMelodyParams(). A separate, shorter stale-data
 *   timer reverts to filter/tremolo/pan defaults if no pencil message
 *   arrives for PENCIL_STALE_TIMEOUT_MS ms (see pencil-mapper.js).
 *
 * @param {object} [opts]
 * @param {object|null} [opts.playback] - Object returned by startPlayback()
 *   ({ switchBed, setTempo, setMelodyParams, revertMelodyDefaults }). If
 *   omitted, messages are still logged but not applied (safe degraded mode
 *   — lets the server run standalone for testing).
 */
export function startServer({ playback = null } = {}) {
  const wss = new WebSocketServer({ host: HOST, port: PORT });
  const smoothVelocity = createVelocitySmoother();
  const trackZone = createZoneTracker(playback?.zone);
  let currentZone = playback?.zone ?? null;

  // ── Biometric no-data fallback timer ─────────────────────────────────────
  // If no biometric message arrives within STALE_TIMEOUT_MS, revert tempo to
  // the neutral rate (1.0) — the zone itself is left as-is (see docstring).
  let staleTimer = null;

  function resetStaleTimer() {
    if (staleTimer) clearTimeout(staleTimer);
    staleTimer = setTimeout(() => {
      if (playback) {
        console.log(`[tempo] no biometric for ${STALE_TIMEOUT_MS}ms — reverting to neutral tempo (rate=1.0)`);
        playback.setTempo(1.0);
      }
    }, STALE_TIMEOUT_MS);
  }

  // ── Pencil no-data fallback timer ────────────────────────────────────────
  let pencilStaleTimer = null;

  function resetPencilStaleTimer() {
    if (pencilStaleTimer) clearTimeout(pencilStaleTimer);
    pencilStaleTimer = setTimeout(() => {
      console.log(`[melody] no pencil for ${PENCIL_STALE_TIMEOUT_MS}ms — reverting to default filter/tremolo/pan`);
      if (playback) playback.revertMelodyDefaults();
    }, PENCIL_STALE_TIMEOUT_MS);
  }

  wss.on("listening", () => {
    console.log(`[server] contract WebSocket server listening on ws://${HOST}:${PORT}`);
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

        const zone = trackZone(message.bpm);
        const rate = bpmToPlaybackRateWithinZone(message.bpm, zone);
        const applyTime = Date.now();
        const transitLatency = typeof message.timestamp === "number" ? rxTime - message.timestamp : null;

        if (playback) {
          if (zone !== currentZone) {
            currentZone = zone;
            playback.switchBed(zone).catch((err) => console.error("[tempo] switchBed failed:", err.message));
          }
          playback.setTempo(rate);
          console.log(
            `[tempo] heart=${message.bpm.toFixed(1)} BPM` +
            ` → zone=${zone} rate=${rate.toFixed(4)}` +
            ` | transit_latency=${transitLatency !== null ? transitLatency + "ms" : "n/a"}` +
            ` | apply_latency=${applyTime - rxTime}ms` +
            ` | msg_ts=${message.timestamp}`
          );
        } else {
          console.log(`[tempo] biometric received but no playback handle — heart=${message.bpm} BPM (no-op)`);
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

        if (playback) {
          playback.setMelodyParams({ cutoffHz, tremoloHz, pan });
          const applyTime = Date.now();
          const transitLatency = typeof message.timestamp === "number" ? rxTime - message.timestamp : null;
          console.log(
            `[melody] tilt=${message.tilt === null ? "null" : message.tilt.toFixed(1)}` +
            ` velocity=${velocity.toFixed(0)}px/s x=${message.x.toFixed(0)}` +
            ` → cutoff=${cutoffHz.toFixed(0)}Hz tremolo=${tremoloHz.toFixed(2)}Hz pan=${pan.toFixed(2)}` +
            ` | transit_latency=${transitLatency !== null ? transitLatency + "ms" : "n/a"}` +
            ` | apply_latency=${applyTime - rxTime}ms`
          );
        } else {
          console.log(`[melody] pencil received but no playback handle — (no-op)`);
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
