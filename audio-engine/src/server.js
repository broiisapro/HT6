import { WebSocketServer } from "ws";
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
  createZoneTracker,
  bpmToPlaybackRateWithinZone,
} from "./biometric-zone-mapper.js";
import {
  pencilToAudioParams,
  quantizePitch,
  createVelocitySmoother,
  STALE_TIMEOUT_MS as PENCIL_STALE_TIMEOUT_MS,
} from "./pencil-mapper.js";

const HOST = "0.0.0.0";
const PORT = 8765;

/** Minimum milliseconds between forwarded beat events (server-side debounce). */
const BEAT_DEBOUNCE_MS = 300;

/**
 * Contract WebSocket server (see ../../contracts/README.md).
 *
 * Epic 3 (mood-zone version): route `type:"biometric"` messages through
 *   createZoneTracker() (bpm -> zone, debounced) and
 *   bpmToPlaybackRateWithinZone() (continuous nudge within that zone), and
 *   apply via playback.switchBed()/setTempo(). A stale-data timer resets
 *   tempo to the neutral rate (1.0) if no biometric arrives for STALE_TIMEOUT_MS.
 * Epic 6: route `type:"pencil"` messages through pencilToAudioParams() and
 *   apply via playback.setMelodyParams().
 * Epic 8: accepts an optional `fallbackPlayer`. When active, live WS messages
 *   are logged but not applied.
 * Epic 8.5: rate-of-change limiting always on; oppositeMood and staticMode
 *   toggled via setOppositeMood/setStaticMode returned from this function.
 * Item 3: `type:"beat"` events → per-heartbeat thump synth via playBeat.
 * Item 4: stress-spike state machine → noise layer via applyStressIntensity.
 * Item 5: `type:"pencil-down"/"pencil-up"` events + pencil y during moves
 *   → monophonic pluck voice via playPluck.
 *
 * Returns { wss, setOppositeMood, setStaticMode } so index.js can wire
 * keypress handlers to the toggles.
 *
 * @param {object} [opts]
 * @param {object|null} [opts.playback] - Object returned by startPlayback()
 *   ({ switchBed, setTempo, setMelodyParams, revertMelodyDefaults }). If
 *   omitted, messages are still logged but not applied (safe degraded mode).
 * @param {import('./fallback-player.js').FallbackPlayer|null} [opts.fallbackPlayer]
 * @param {((gain: number, isPeakEntry: boolean) => void)|null} [opts.applyStressIntensity]
 *   Item 4: called on every biometric message with current stress intensity.
 * @param {(() => void)|null} [opts.playBeat]
 *   Item 3: called on each debounced `type:"beat"` message.
 * @param {((freqHz: number) => void)|null} [opts.playPluck]
 *   Item 5: called on pencil-down and retrigger-on-bucket-change during a stroke.
 */
export function startServer({
  playback = null,
  fallbackPlayer = null,
  applyStressIntensity = null,
  playBeat = null,
  playPluck = null,
} = {}) {
  const wss = new WebSocketServer({ host: HOST, port: PORT });

  // Zone tracker: derives current active zone from BPM (with hysteresis dwell).
  const trackZone = createZoneTracker(playback?.zone);
  let currentZone = playback?.zone ?? null;

  // Rate limiter (Epic 8.5): caps BPM change at MAX_BPM_CHANGE_PER_SEC per second.
  const rateLimiter = createBpmRateLimiter();

  // Item 3: beat debounce state.
  let lastBeatRxMs = 0;

  // Item 5: track pitch bucket across move events during an active stroke.
  let lastPitchIndex = -1;

  // Item 4: stress-spike state machine.
  const stressMachine = createStressStateMachine();

  // ── Epic 8.5: rate limiter + mode state ─────────────────────────────────
  // Toggled at runtime by setOppositeMood / setStaticMode (returned below).
  let oppositeMoodEnabled = false;
  let staticModeEnabled   = false;

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
  // to its native rate (1.0) so music keeps playing at a sensible default.
  // The zone itself is deliberately NOT reverted — falling back to a default
  // zone on a brief gap would be a jarring, unmotivated crossfade.
  let staleTimer = null;

  function resetStaleTimer() {
    if (staleTimer) clearTimeout(staleTimer);
    staleTimer = setTimeout(() => {
      // Epic 8: suppress revert while fallback is replaying biometric data.
      if (fallbackPlayer?.active) return;
      if (playback) {
        console.log(
          `[tempo] no biometric for ${STALE_TIMEOUT_MS}ms — reverting to neutral tempo (rate=1.0)`
        );
        playback.setTempo(1.0);
      }
      // Item 4: stale data forces stress machine back to CALM.
      stressMachine.forceCalm();
      if (applyStressIntensity) applyStressIntensity(0, false);
    }, STALE_TIMEOUT_MS);
  }

  // ── Pencil no-data fallback timer ────────────────────────────────────────
  let pencilStaleTimer = null;

  function resetPencilStaleTimer() {
    if (pencilStaleTimer) clearTimeout(pencilStaleTimer);
    pencilStaleTimer = setTimeout(() => {
      // Epic 8: suppress revert while fallback is replaying pencil data.
      if (fallbackPlayer?.active) return;
      console.log(
        `[melody] no pencil for ${PENCIL_STALE_TIMEOUT_MS}ms — reverting to default filter/tremolo/pan`
      );
      if (playback) playback.revertMelodyDefaults();
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
    // EMA carries stale velocity state across reconnects, producing incorrect
    // tremolo values on the first strokes of a new session.
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

        // Epic 8.5 pipeline: clamp → rate-limit → (optional invert) → zone + rate.
        const clamped   = clampBpm(message.bpm);
        const limited   = rateLimiter(clamped, rxTime);
        const effective = oppositeMoodEnabled ? applyMoodInversion(limited) : limited;

        // Item 4: stress state machine — runs on every biometric message.
        const prevState = stressMachine.getState();
        const intensity01 = stressMachine.update(effective, rxTime);
        const newState    = stressMachine.getState();
        const isPeakEntry = prevState !== STRESS_STATE.PEAK && newState === STRESS_STATE.PEAK;
        if (applyStressIntensity) applyStressIntensity(intensity01, isPeakEntry);
        if (newState !== prevState) {
          console.log(`[stress] ${prevState} → ${newState} (intensity=${intensity01.toFixed(3)})`);
        }

        // Zone tracking: switch bed if BPM moved to a new zone (with hysteresis).
        const zone     = trackZone(effective);
        const zoneRate = bpmToPlaybackRateWithinZone(effective, zone);

        if (playback) {
          if (zone !== currentZone) {
            currentZone = zone;
            playback.switchBed(zone).catch((err) => console.error("[tempo] switchBed failed:", err.message));
          }
          playback.setTempo(zoneRate);
        }

        const applyTime = Date.now();
        const transitLatency = typeof message.timestamp === "number"
          ? rxTime - message.timestamp
          : null;
        const rateLimitedStr = limited !== clamped
          ? ` (rate-limited from ${clamped.toFixed(1)})`
          : "";
        const moodStr = oppositeMoodEnabled
          ? ` [mood-inverted: raw-clamped=${clamped.toFixed(1)}]`
          : "";
        console.log(
          `[tempo] heart=${message.bpm.toFixed(1)} BPM` +
          ` → effective=${effective.toFixed(1)} BPM${rateLimitedStr}${moodStr}` +
          ` → zone=${zone} rate=${zoneRate.toFixed(4)}` +
          ` stress=${newState}(${intensity01.toFixed(2)})` +
          ` | transit_latency=${transitLatency !== null ? transitLatency + "ms" : "n/a"}` +
          ` | apply_latency=${applyTime - rxTime}ms` +
          ` | msg_ts=${message.timestamp}`
        );
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

        if (playback) {
          playback.setMelodyParams({ cutoffHz, tremoloHz, pan });
        }

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

  return { wss, setOppositeMood, setStaticMode };
}
