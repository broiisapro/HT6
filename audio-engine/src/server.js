import { WebSocketServer } from "ws";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  clampBpm,
  createBpmRateLimiter,
  applyMoodInversion,
  createStressStateMachine,
  STRESS_STATE,
  BED_BPM,
  STALE_TIMEOUT_MS,
} from "./biometric-mapper.js";
import {
  ZONE_BANDS,
  INTENTION_BANDS,
  classifyZone,
  createZoneTracker,
  bpmToPlaybackRateWithinZone,
  MIN_DWELL_MS,
} from "./biometric-zone-mapper.js";
import {
  pencilToAudioParams,
  quantizePitch,
  createVelocitySmoother,
  DEFAULT_CUTOFF_HZ,
  DEFAULT_TREMOLO_HZ,
  DEFAULT_PAN,
  STALE_TIMEOUT_MS as PENCIL_STALE_TIMEOUT_MS,
} from "./pencil-mapper.js";
import { placeEmergencyCall } from "./emergency-caller.js";

const HOST = "0.0.0.0";
const PORT = 8765;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");

const VALID_ZONES = Object.keys(ZONE_BANDS);
const VALID_INTENTIONS = Object.keys(INTENTION_BANDS);

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
 * Epic 8.5: three hardening features added — all are toggled at runtime:
 *   - Rate-of-change limiting (always on): BPM can only move MAX_BPM_CHANGE_PER_SEC
 *     per second, converting sensor spikes into graceful ramps.
 *   - Opposite-mood toggle (setOppositeMood): inverts BPM mapping so high HR
 *     → calmer output and low HR → more energetic output.
 *   - Static/dynamic mode (setStaticMode): when static, incoming biometric and
 *     pencil messages are logged but not applied; music stays at its frozen state.
 *
 * Returns { wss, setOppositeMood, setStaticMode } so index.js can wire
 * keypress handlers to the toggles.
 *
 * @param {object} [opts]
 * @param {AudioBufferSourceNode|null} [opts.sourceNode] - The looping bed source.
 * @param {BiquadFilterNode|null} [opts.filterNode] - Epic 6 brightness filter.
 * @param {StereoPannerNode|null} [opts.pannerNode] - Epic 6 stereo pan.
 * @param {OscillatorNode|null} [opts.lfo] - Epic 6 tremolo-rate oscillator.
 * @param {import('./fallback-player.js').FallbackPlayer|null} [opts.fallbackPlayer]
 *   All four audio nodes are returned by startPlayback(). Any omitted/null
 *   node means its corresponding messages are still logged but not applied
 *   (safe degraded mode) — lets the server run standalone for testing.
 */

/** Minimum milliseconds between forwarded beat events (server-side debounce). */
const BEAT_DEBOUNCE_MS = 300;

export function startServer({
  sourceNode = null,
  filterNode = null,
  pannerNode = null,
  lfo = null,
  fallbackPlayer = null,
  playBeat = null,
  applyStressIntensity = null,
  playPluck = null,
  // Epic 9: switchBed(zoneName) crossfades audio profile on zone switch.
  // Provided by startPlayback(); null means zone tracking still runs but no
  // audio profile change is applied (useful for headless testing).
  switchBed = null,
  // Epic 9: dwell window override for tests. undefined → use MIN_DWELL_MS.
  zoneDwellMs = undefined,
} = {}) {
  const wss = new WebSocketServer({ host: HOST, port: PORT });

  // ── Item 3: beat debounce state ─────────────────────────────────────────
  let lastBeatRxMs = 0;

  // ── Item 5: pencil melody voice state (per-server, not per-connection) ────
  // lastPitchIndex tracks the last quantized bucket during an active stroke,
  // so we can detect retrigger-on-bucket-change.
  let lastPitchIndex = -1;

  // ── Item 4: stress-spike state machine ──────────────────────────────────
  const stressMachine = createStressStateMachine();

  // ── Epic 8.5: rate limiter + mode state ─────────────────────────────────
  // Rate limiter is always active (no on/off toggle — it's a safety net).
  const rateLimiter = createBpmRateLimiter();

  // Toggled at runtime by setOppositeMood / setStaticMode (returned below).
  let oppositeMoodEnabled = false;
  let staticModeEnabled = false;

  // ── Epic 9: zone / mode / intention state ────────────────────────────────
  // Boots into dynamic / match_my_energy per spec. In-memory only.
  //
  // serverMode:      "dynamic" | "static"  — current performer mode.
  // activeIntention: intention name for dynamic mode.
  // pinnedZone:      zone name for static mode (null in dynamic).
  // activeZone:      the zone currently confirmed by the tracker (dynamic) or
  //                  pinned (static). null until first biometric arrives.
  let serverMode       = "dynamic";
  let activeIntention  = "match_my_energy";
  let pinnedZone       = null;
  let activeZone       = null;

  // Zone tracker: debounces biometric-driven zone switches (dynamic mode).
  // Manual mode/zone WS messages bypass this via zoneTracker.forceZone().
  const zoneTracker = createZoneTracker(
    zoneDwellMs !== undefined ? zoneDwellMs : MIN_DWELL_MS
  );

  // ── simulate-heart-attack debounce state ─────────────────────────────────
  let lastHeartAttackTriggerMs = 0;
  const HEART_ATTACK_DEBOUNCE_MS = 30_000;

  // ── Epic 9: UI client registry + state broadcast ─────────────────────────
  // Sockets that send a type:"mode" message are tagged as UI clients.
  // Only UI clients receive state broadcast payloads (biometric/pencil senders
  // are fire-and-forget and never expect a response).
  const uiClients = new Set();

  /**
   * Build and send the current mode/zone/intention state to all UI clients.
   * Called on every zone switch (dynamic mode) and on every mode message.
   */
  function broadcastState() {
    const payload = JSON.stringify({
      type:      "state",
      mode:      serverMode,
      zone:      activeZone,
      intention: serverMode === "dynamic" ? activeIntention : null,
      pinnedZone: serverMode === "static" ? pinnedZone : null,
      timestamp: Date.now(),
    });
    let sent = 0;
    for (const client of uiClients) {
      if (client.readyState === 1 /* WebSocket.OPEN */) {
        client.send(payload);
        sent++;
      }
    }
    if (sent > 0) {
      console.log(`[mode/broadcast] → ${sent} UI client(s): mode=${serverMode}` +
        ` zone=${activeZone} intention=${activeIntention ?? "n/a"}` +
        ` pinnedZone=${pinnedZone ?? "n/a"}`);
    }
  }

  function setOppositeMood(enabled) {
    oppositeMoodEnabled = !!enabled;
    console.log(
      oppositeMoodEnabled
        ? "[mood] opposite mood ON  — high HR → calmer output"
        : "[mood] opposite mood OFF — normal mapping restored"
    );
  }

  function setStaticMode(enabled) {
    staticModeEnabled = !!enabled;
    console.log(
      staticModeEnabled
        ? "[mode] static mode ON  — output frozen (live input ignored)"
        : "[mode] static mode OFF — resuming live control"
    );
  }

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
      // Item 4: stale data forces stress machine back to CALM.
      stressMachine.forceCalm();
      if (applyStressIntensity) applyStressIntensity(0, false);
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

        // Always reset the stale timer — the source is live even in static mode.
        resetStaleTimer();

        if (staticModeEnabled) {
          console.log(`[tempo] static mode — ignoring heart=${message.bpm.toFixed(1)} BPM`);
          return;
        }

        // Epic 8.5 pipeline: clamp → rate-limit → (optional invert).
        const clamped = clampBpm(message.bpm);
        const limited = rateLimiter(clamped, rxTime);
        const effective = oppositeMoodEnabled ? applyMoodInversion(limited) : limited;

        // Epic 9: zone-aware rate routing.
        //
        // Static mode: zone is pinned by the performer. Compute a ±8% tempo
        //   nudge within pinnedZone using bpmToPlaybackRateWithinZone() so the
        //   music tempo still reflects HR without ever switching mood zones.
        //
        // Dynamic mode: classify BPM into a zone per the active intention's
        //   band table, run through dwell hysteresis, call switchBed() on
        //   confirmed zone switches, then use the direct BPM/BED_BPM rate
        //   (preserving the existing linear tempo feel for this mode).
        let rate;
        let zoneStr = "";
        if (serverMode === "static") {
          rate = bpmToPlaybackRateWithinZone(effective, pinnedZone);
          zoneStr = ` [static zone=${pinnedZone}]`;
        } else {
          // Dynamic: zone tracking + switchBed, then direct rate.
          const bands = INTENTION_BANDS[activeIntention];
          const candidate = classifyZone(effective, bands);
          const { zone, switched } = zoneTracker.update(candidate, rxTime);
          if (switched) {
            const prev = activeZone;
            activeZone = zone;
            console.log(`[zone] ${prev ?? "none"} → ${activeZone} (intention=${activeIntention})`);
            if (switchBed) switchBed(activeZone);
            broadcastState();
          }
          zoneStr = ` [zone=${activeZone ?? "pending"}]`;
          rate = effective / BED_BPM;
        }

        // Item 4: stress state machine — runs on every biometric message.
        const prevState = stressMachine.getState();
        const intensity01 = stressMachine.update(effective, rxTime);
        const newState    = stressMachine.getState();
        const isPeakEntry = prevState !== STRESS_STATE.PEAK && newState === STRESS_STATE.PEAK;
        if (applyStressIntensity) applyStressIntensity(intensity01, isPeakEntry);
        if (newState !== prevState) {
          console.log(`[stress] ${prevState} → ${newState} (intensity=${intensity01.toFixed(3)})`);
        }

        if (sourceNode) {
          sourceNode.playbackRate.value = rate;
          const applyTime = Date.now();
          const transitLatency = typeof message.timestamp === "number"
            ? rxTime - message.timestamp
            : null;
          const rateLimitedStr = limited !== clamped
            ? ` (rate-limited from ${clamped.toFixed(1)})`
            : "";
          const moodStr = oppositeMoodEnabled ? ` [mood-inverted: raw-clamped=${clamped.toFixed(1)}]` : "";
          console.log(
            `[tempo] heart=${message.bpm.toFixed(1)} BPM` +
            ` → effective=${effective.toFixed(1)} BPM${rateLimitedStr}${moodStr}${zoneStr}` +
            ` → playbackRate=${rate.toFixed(4)}` +
            ` | transit_latency=${transitLatency !== null ? transitLatency + "ms" : "n/a"}` +
            ` | apply_latency=${applyTime - rxTime}ms` +
            ` | msg_ts=${message.timestamp}`
          );
        } else {
          console.log(`[tempo] biometric received but no sourceNode — heart=${message.bpm} BPM (no-op)`);
        }
      }

      // ── Epic 9: type:"mode" — performer mode/intention/zone selection ──────
      // Receiving this message tags the sender as a UI client: it will receive
      // state broadcast payloads on every zone switch and mode change.
      // Multiple UI clients are supported (e.g. performer + stage monitor tabs).
      if (message.type === "mode") {
        // Tag this socket as a UI client (idempotent).
        if (!socket._isUiClient) {
          socket._isUiClient = true;
          uiClients.add(socket);
          console.log(`[mode] socket ${remote} registered as UI client (${uiClients.size} total)`);
        }

        const { mode, zone, intention } = message;

        if (mode === "static") {
          if (!zone || !ZONE_BANDS[zone]) {
            console.warn(`[mode] static: invalid zone "${zone}" — must be one of: ${Object.keys(ZONE_BANDS).join(", ")}`);
            return;
          }
          serverMode = "static";
          pinnedZone = zone;
          activeZone = zone;                // update display zone immediately
          zoneTracker.forceZone(zone);      // sync tracker for when we return to dynamic
          console.log(`[mode] → static  pinnedZone=${pinnedZone}`);

        } else if (mode === "dynamic") {
          if (!intention || !INTENTION_BANDS[intention]) {
            console.warn(`[mode] dynamic: invalid intention "${intention}" — must be one of: ${Object.keys(INTENTION_BANDS).join(", ")}`);
            return;
          }
          serverMode = "dynamic";
          activeIntention = intention;
          pinnedZone = null;
          console.log(`[mode] → dynamic  intention=${activeIntention}`);

        } else {
          console.warn(`[mode] unknown mode "${mode}" — ignored`);
          return;
        }

        // Broadcast updated state to all UI clients (including the sender).
        broadcastState();
      }

      if (message.type === "pencil-down") {
        // Note-on: quantize y → pitch bucket and trigger immediately.
        if (typeof message.x === "number" && typeof message.y === "number") {
          const { freqHz, index } = quantizePitch(message.y);
          lastPitchIndex = index;
          console.log(`[melody] pencil-down y=${message.y.toFixed(1)} → ${freqHz.toFixed(2)}Hz (bucket=${index})`);
          if (playPluck) playPluck(freqHz);
        }
      }

      if (message.type === "pencil-up") {
        // Note-off: let the natural decay ride out (no explicit stop).
        lastPitchIndex = -1;
        console.log(`[melody] pencil-up — note released (decay rides out)`);
      }

      if (message.type === "beat") {
        // Debounce: ignore beats closer than BEAT_DEBOUNCE_MS to guard against
        // double-detection bugs and BLE notification flooding.
        if (rxTime - lastBeatRxMs < BEAT_DEBOUNCE_MS) {
          console.log(`[beat] debounced (${rxTime - lastBeatRxMs}ms since last beat)`);
        } else {
          lastBeatRxMs = rxTime;
          console.log(`[beat] thump @ ts=${message.timestamp}`);
          if (playBeat) playBeat();
        }
      }

      if (message.type === "simulate-heart-attack") {
        if (rxTime - lastHeartAttackTriggerMs < HEART_ATTACK_DEBOUNCE_MS) {
          console.log(`[emergency] simulate-heart-attack debounced (${rxTime - lastHeartAttackTriggerMs}ms since last trigger)`);
          return;
        }
        lastHeartAttackTriggerMs = rxTime;
        console.log(`[emergency] simulate-heart-attack triggered — calling ${process.env.EMERGENCY_CONTACT_PHONE ?? "(not configured)"}`);
        placeEmergencyCall({ timestamp: Date.now() });
      }

      if (message.type === "tip") {
        const amount = Number(message.amount);
        const token = typeof message.token === "string" ? message.token.toUpperCase() : "UNKNOWN";
        if (!Number.isFinite(amount) || amount <= 0) {
          console.warn("[tip] message missing positive numeric amount — ignored");
          return;
        }

        console.log(`[tip] live tip confirmed: ${amount.toFixed(2)} ${token}`);
        // Additive-only implementation: reuse existing beat synth as a short,
        // layered double-hit accent without touching biometric/pencil logic.
        if (playBeat) {
          playBeat(0.75);
          setTimeout(() => playBeat(0.45), 120);
        }
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

        // Always reset the pencil stale timer — the Pencil is still live.
        resetPencilStaleTimer();

        if (staticModeEnabled) {
          console.log(`[melody] static mode — ignoring pencil x=${message.x} tilt=${message.tilt} vel=${message.velocity}`);
          return;
        }

        const velocity = smoothVelocity(message.velocity);
        const { cutoffHz, tremoloHz, pan } = pencilToAudioParams({
          x: message.x,
          velocity,
          tilt: message.tilt,
        });

        // Item 5: retrigger melody voice when the quantized pitch bucket changes.
        // Only retrigger if a stroke is active (lastPitchIndex !== -1).
        if (typeof message.y === "number" && lastPitchIndex !== -1 && playPluck) {
          const { freqHz, index } = quantizePitch(message.y);
          if (index !== lastPitchIndex) {
            lastPitchIndex = index;
            console.log(`[melody] pitch retrigger → bucket=${index} ${freqHz.toFixed(2)}Hz`);
            playPluck(freqHz);
          }
        }

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
      }
    });

    socket.on("close", () => {
      // Epic 9: deregister UI clients so broadcasts don't pile up on dead sockets.
      if (socket._isUiClient) {
        uiClients.delete(socket);
        console.log(`[server] UI client disconnected: ${remote} (${uiClients.size} remaining)`);
      } else {
        console.log(`[server] client disconnected: ${remote}`);
      }
    });

    socket.on("error", (err) => {
      console.error(`[server] socket error from ${remote}:`, err.message);
    });
  });

  wss.on("error", (err) => {
    console.error("[server] server error:", err.message);
  });

  return { wss, setOppositeMood, setStaticMode };
}
