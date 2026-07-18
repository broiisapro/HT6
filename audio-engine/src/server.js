import { WebSocketServer } from "ws";
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createZoneTracker,
  bpmToPlaybackRateWithinZone,
  STALE_TIMEOUT_MS,
  ZONE_BANDS,
  INTENTION_CLASSIFIERS,
  DEFAULT_INTENTION,
} from "./biometric-zone-mapper.js";
import {
  pencilToAudioParams,
  createVelocitySmoother,
  STALE_TIMEOUT_MS as PENCIL_STALE_TIMEOUT_MS,
} from "./pencil-mapper.js";

const HOST = "0.0.0.0";
const PORT = 8765;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");

const VALID_ZONES = ZONE_BANDS.map((b) => b.zone);
const VALID_INTENTIONS = Object.keys(INTENTION_CLASSIFIERS);

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

/**
 * Epic 9: minimal static file server for the mode-selector UI
 * (`audio-engine/public/`, built from the sibling `ui/` sub-package via
 * `npm run build:ui`). Attached to the *same* HTTP server the WebSocket
 * server upgrades from — one port (8765) for everything, so a performer on
 * the LAN only needs one address (`http://<mac-ip>:8765` for the UI,
 * `ws://<mac-ip>:8765` for the contract socket) rather than remembering two
 * ports. `ws`'s `WebSocketServer` only intercepts the HTTP `upgrade` event;
 * plain GET requests fall through to this listener untouched.
 */
async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let filePath = url.pathname === "/" ? "/index.html" : url.pathname;
  filePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, "");
  const resolved = path.join(PUBLIC_DIR, filePath);

  try {
    const data = await readFile(resolved);
    const ext = path.extname(resolved).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] ?? "application/octet-stream" });
    res.end(data);
  } catch (err) {
    if (err.code === "ENOENT") {
      // SPA fallback: unknown paths (client-side routes, none currently) serve index.html.
      try {
        const data = await readFile(path.join(PUBLIC_DIR, "index.html"));
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(data);
      } catch {
        res.writeHead(404);
        res.end("Not found");
      }
    } else {
      res.writeHead(500);
      res.end("Internal error");
    }
  }
}

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
  const httpServer = http.createServer((req, res) => {
    serveStatic(req, res).catch((err) => {
      console.error("[server] static file error:", err.message);
      res.writeHead(500);
      res.end("Internal error");
    });
  });
  const wss = new WebSocketServer({ server: httpServer });
  const smoothVelocity = createVelocitySmoother();
  const zoneTracker = createZoneTracker(playback?.zone);
  let currentZone = playback?.zone ?? null;
  let lastBpm = null;

  // ── Epic 9: mode/intention state ─────────────────────────────────────────
  // "dynamic" (bpm drives zone via one of three intention strategies) or
  // "static" (performer pins one zone; bpm keeps nudging tempo within it but
  // never switches zone). Always boots into dynamic/match_my_energy per the
  // epic's definition of done — no persistence across restarts.
  let mode = "dynamic";
  let intention = DEFAULT_INTENTION;
  let pinnedZone = null;

  // Sockets tagged as UI clients (connected via `?client=ui`) — the only
  // ones that receive `state` broadcasts. Biometric/pencil senders are
  // fire-and-forget and never expect a reply, so they're deliberately never
  // added here.
  const uiSockets = new Set();

  function broadcastState() {
    const payload = JSON.stringify({
      type: "state",
      mode,
      zone: currentZone,
      pinnedZone,
      intention,
      timestamp: Date.now(),
    });
    for (const uiSocket of uiSockets) {
      if (uiSocket.readyState === uiSocket.OPEN) uiSocket.send(payload);
    }
  }

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

  httpServer.listen(PORT, HOST, () => {
    console.log(`[server] contract WebSocket + control-UI server listening on http://${HOST}:${PORT} (ws://${HOST}:${PORT})`);
    resetStaleTimer();
    resetPencilStaleTimer();
  });

  wss.on("connection", (socket, req) => {
    const remote = req.socket.remoteAddress;
    const url = new URL(req.url, "http://placeholder");
    const isUiClient = url.searchParams.get("client") === "ui";
    if (isUiClient) {
      uiSockets.add(socket);
      console.log(`[server] UI client connected from ${remote}`);
      socket.send(
        JSON.stringify({ type: "state", mode, zone: currentZone, pinnedZone, intention, timestamp: Date.now() })
      );
    } else {
      console.log(`[server] client connected from ${remote}`);
    }

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
        lastBpm = message.bpm;

        // Epic 9: in static mode, bpm still nudges tempo but NEVER switches
        // zone — the performer pinned it. In dynamic mode, classify through
        // whichever intention strategy is currently selected (still the
        // same dwell/hysteresis debounce underneath — see biometric-zone-mapper.js).
        const zone =
          mode === "static" ? pinnedZone : zoneTracker.track(message.bpm, INTENTION_CLASSIFIERS[intention]);
        const rate = bpmToPlaybackRateWithinZone(message.bpm, zone);
        const applyTime = Date.now();
        const transitLatency = typeof message.timestamp === "number" ? rxTime - message.timestamp : null;

        if (playback) {
          if (mode === "dynamic" && zone !== currentZone) {
            currentZone = zone;
            playback.switchBed(zone).catch((err) => console.error("[tempo] switchBed failed:", err.message));
            broadcastState();
          }
          playback.setTempo(rate);
          console.log(
            `[tempo] heart=${message.bpm.toFixed(1)} BPM` +
            ` → mode=${mode} zone=${zone} rate=${rate.toFixed(4)}` +
            ` | transit_latency=${transitLatency !== null ? transitLatency + "ms" : "n/a"}` +
            ` | apply_latency=${applyTime - rxTime}ms` +
            ` | msg_ts=${message.timestamp}`
          );
        } else {
          console.log(`[tempo] biometric received but no playback handle — heart=${message.bpm} BPM (no-op)`);
        }
        resetStaleTimer();
      }

      if (message.type === "mode") {
        if (message.mode !== "static" && message.mode !== "dynamic") {
          console.warn(`[mode] invalid mode "${message.mode}" — ignored`);
          return;
        }

        if (message.mode === "static") {
          if (!VALID_ZONES.includes(message.zone)) {
            console.warn(`[mode] static mode requires a valid zone (one of ${VALID_ZONES.join(", ")}) — ignored`);
            return;
          }
          mode = "static";
          pinnedZone = message.zone;
          zoneTracker.forceZone(message.zone); // so a later switch back to dynamic resumes from here, not a stale committed zone
          console.log(`[mode] → static, pinned to "${pinnedZone}"`);

          if (playback && pinnedZone !== currentZone) {
            currentZone = pinnedZone;
            // Applies immediately — a deliberate performer tap, not noisy sensor data that should ease in.
            playback.switchBed(pinnedZone).catch((err) => console.error("[mode] switchBed failed:", err.message));
          }
        } else {
          if (!VALID_INTENTIONS.includes(message.intention)) {
            console.warn(`[mode] dynamic mode requires a valid intention (one of ${VALID_INTENTIONS.join(", ")}) — ignored`);
            return;
          }
          mode = "dynamic";
          intention = message.intention;
          pinnedZone = null;
          console.log(`[mode] → dynamic, intention "${intention}"`);

          // Re-evaluate immediately against the last-known bpm so switching
          // intention feels live rather than waiting for the next biometric
          // message (which could be up to ~1s away).
          if (playback && lastBpm !== null) {
            const zone = INTENTION_CLASSIFIERS[intention](lastBpm);
            zoneTracker.forceZone(zone);
            if (zone !== currentZone) {
              currentZone = zone;
              playback.switchBed(zone).catch((err) => console.error("[mode] switchBed failed:", err.message));
            }
          }
        }

        broadcastState();
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
      uiSockets.delete(socket);
      console.log(`[server] client disconnected: ${remote}`);
    });

    socket.on("error", (err) => {
      console.error(`[server] socket error from ${remote}:`, err.message);
    });
  });

  wss.on("error", (err) => {
    console.error("[server] server error:", err.message);
  });

  httpServer.on("error", (err) => {
    console.error("[server] HTTP server error:", err.message);
  });

  return wss;
}
