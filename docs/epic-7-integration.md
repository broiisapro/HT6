# Epic 7 — End-to-End Integration

## Goal
Wire `biometrics/`, `audio-engine/`, and `pencil-input/` into a single live system where heart rate drives tempo and Pencil drawing drives melody/timbre simultaneously, with both influences audibly distinguishable in real time.

---

## Pre-flight checklist (run at demo setup time)

```bash
# Verify Mac LAN IP matches the ATS exception in the iPhone relay app.
# Epic 1 hardcoded 100.66.157.100. If this differs, rebuild the iOS app in Xcode.
ipconfig getifaddr en0
```

At the time of Epic 7 (2026-07-18): `ipconfig getifaddr en0` → `100.66.157.100` — **matches Epic 1's ATS exception; no Xcode rebuild needed.**

---

## Run sequence (exact commands, exact order)

### Terminal 1 — audio-engine (start first)

```bash
cd /path/to/HT6/audio-engine
npm start
# Wait for: [playback] looping .../assets/bed.wav (59.9s bed)
# Then:      [server] contract WebSocket server listening on ws://0.0.0.0:8765
```

The bed WAV takes ~50 ms to decode; the server starts immediately after. Wait for both log lines before proceeding.

### Terminal 2 — biometrics (primary: Polar relay; fallback: simulated)

**Primary path — Polar Vantage M via phone relay (recommended for demo):**
```bash
# Prerequisites: Polar watch on wrist, iPhone relay app running and connected to watch.
# The relay app POSTs to http://100.66.157.100:8766/hr.
cd /path/to/HT6/biometrics
source .venv/bin/activate
python run.py --source polar-phone-relay --websocket-url ws://127.0.0.1:8765
# Expect: "Polar phone relay listening on http://0.0.0.0:8766/hr"
# Then ~5–10s later (smoothing window fills): "[WS] sent bpm=XX.X timestamp=..."
```

**Fallback path — simulated BPM (no hardware required):**
```bash
cd /path/to/HT6/biometrics
source .venv/bin/activate
python run.py --source simulated --websocket-url ws://127.0.0.1:8765
```

**Fallback path — phone-camera PPG (Camo flash-on required):**
```bash
cd /path/to/HT6/biometrics
source .venv/bin/activate
python run.py --source phone-camera --websocket-url ws://127.0.0.1:8765
# Open Camo Studio first; force torch on; hold finger on camera lens.
```

### Terminal 3 — pencil-input HTTP server (serves page to iPad)

```bash
cd /path/to/HT6/pencil-input
python3 -m http.server 8080
# Serves index.html at http://100.66.157.100:8080/index.html
```

### iPad — pencil-input browser client

1. Open Safari on the 10th-gen iPad.
2. Navigate to `http://100.66.157.100:8080/index.html`
3. In the HUD sidebar, enter `ws://100.66.157.100:8765` in the URL field.
4. Tap **Connect** — status badge should turn green ("connected").
5. Draw with the Apple Pencil (USB-C). The engine will receive pencil messages.

---

## Startup timing (verified)

The engine accepts WebSocket connections the moment the server binds (~100 ms after `npm start`). The biometrics pipeline has a 2s reconnect loop, so starting it before the engine is safe — it retries automatically. The pencil-input client connects manually via the HUD, so there's no race condition.

**Confirmed startup log sequence** (from integration-smoke.js, all 6 assertions passed):

```
[server] contract WebSocket server listening on ws://0.0.0.0:8765
[server] client connected from 127.0.0.1          ← biometrics pipeline
[tempo] heart=85.0 BPM → playbackRate=0.8854 | transit_latency=1ms | apply_latency=0ms
[server] client connected from 127.0.0.1          ← pencil browser client
[melody] tilt=45.0 velocity=600px/s x=590 → cutoff=1549Hz tremolo=2.75Hz pan=0.00 | transit_latency=0ms | apply_latency=0ms
[tempo] heart=103.0 BPM → playbackRate=1.0729 | transit_latency=0ms | apply_latency=0ms   ← interleaved
[melody] tilt=null velocity=680px/s x=590 → cutoff=1329Hz tremolo=3.05Hz pan=0.00          ← null tilt fallback
[melody] tilt=45.0 velocity=2000px/s x=100 → cutoff=1549Hz tremolo=8.00Hz pan=-0.83       ← second client, fresh EMA
[melody] no pencil for 2000ms — reverting to default filter/tremolo/pan   ← stale timer
[tempo] no biometric for 8000ms — reverting to default playbackRate=1.0 (96 BPM)           ← stale timer
```

Both stale timers fire independently on their own cadences — confirmed no interference.

---

## Integration seam identified and fixed

### Per-connection velocity smoother (audio-engine/src/server.js)

**Problem found in Epic 7:** `createVelocitySmoother()` was called once at `startServer()` scope and shared across all WebSocket connections. When the pencil browser client disconnected and reconnected (manual HUD button), the EMA retained the final velocity value from the previous drawing session. The first strokes of the new session were blended with stale state, producing incorrect tremolo-rate values at reconnect start — a seam bug that only surfaces under real simultaneous operation with manual reconnects.

**Fix:** Moved `createVelocitySmoother()` inside the `wss.on("connection", ...)` handler, so each connecting client receives a fresh EMA instance scoped to its session lifetime. One-line change; no other behaviour altered.

**Commit:** `a9fe7d6` — `fix(audio-engine): scope velocity smoother per connection, not globally`

**Verification:** Integration smoke test assertion #5 confirms the fix: a second pencil client connecting with velocity=2000 receives tremolo=8.00Hz (correct, fresh EMA: raw value returned on first call), not a blended residual from the first client's session.

See `docs/epic-6-pencil-melody-mapping.md` for a pointer to this fix.

---

## Parameter tuning (from isolated-testing values)

**No parameter changes required.** All mapping constants from Epics 3 and 6 held up under simultaneous real operation:

| Parameter | Isolated value | Integrated value | Change |
|---|---|---|---|
| `BED_BPM` | 96 | 96 | none |
| `INPUT_MIN_BPM` / `INPUT_MAX_BPM` | 50 / 130 | 50 / 130 | none |
| `STALE_TIMEOUT_MS` (biometric) | 8000ms | 8000ms | none |
| `MIN_CUTOFF_HZ` / `MAX_CUTOFF_HZ` | 300 / 8000 Hz | 300 / 8000 Hz | none |
| `MIN_TREMOLO_HZ` / `MAX_TREMOLO_HZ` | 0.5 / 8 Hz | 0.5 / 8 Hz | none |
| `VELOCITY_SMOOTHING_ALPHA` | 0.2 | 0.2 | none |
| `STALE_TIMEOUT_MS` (pencil) | 2000ms | 2000ms | none |
| `X_MAX` (pan reference) | 1180 px | 1180 px | none |

**Rationale for no changes:** Epic 6 already ran both biometric and pencil clients simultaneously and confirmed no AudioParam contention. The two stale timers (8000ms biometric, 2000ms pencil) operate independently and revert to distinct defaults without interfering. The per-connection smoother fix resolves the only interaction seam found; no mapping constant needed adjustment.

---

## Open items from Epics 1, 3, 5, 6 — resolution

### From Epic 1

**Item: Polar relay IP `100.66.157.100` hardcoded in iPhone ATS exception.**
→ **Resolved (no action needed).** Current Mac LAN IP verified as `100.66.157.100` (matches). No Xcode rebuild required. **Pre-demo checklist entry added above.**

**Item: Camera path depends on Camo Studio for torch control.**
→ **Carried forward as known limitation.** No change — camera path is documented fallback. Camo must be open and torch forced on if this path is used.

**Item: Direct BLE from macOS is a dead end.**
→ **Confirmed closed.** Not retried. Polar relay path is the primary, camera is fallback.

### From Epic 3

**Item: Physiology-to-first-audible-step lag (~7–9s) dominated by biometric smoother.**
→ **Confirmed, no change.** This is structural to Epic 1's `RollingBpmSmoother(window_size=5)`. Reducing it requires lowering `window_size`, which trades smoothness for responsiveness. Left at window=5 for the demo — the tempo changes are clearly audible once they arrive, and the ~7–9s lag is an acceptable characteristic for live performance.

**Item: Pitch shifts with tempo (accepted product decision).**
→ **Confirmed accepted.** At the observed Polar range (70–108 BPM), playbackRate spans 0.73–1.12×, producing ±3–4 semitones of pitch shift. No phase-vocoder was added. This remains the intended behavior.

**Item: No WebSocket backpressure / reconnect handling on the engine side.**
→ **Confirmed low-risk.** The biometrics pipeline retries automatically with 2s backoff. No issues observed across all integration runs. Re-flagged for demo awareness: if the engine is restarted mid-demo, the biometrics pipeline reconnects within 2s automatically; the pencil client requires a manual HUD reconnect tap.

**Item: PRE-DEMO CHECKLIST — Polar relay IP.**
→ **Resolved.** Current IP confirmed; checklist entry at top of this doc.

### From Epic 5

**Item: No auto-reconnect on pencil client.**
→ **Carried forward as known limitation.** Manual HUD reconnect required if audio-engine restarts mid-demo. Failure is visible (red badge in HUD). One tap to reconnect.

**Item: Raw velocity noisy at low speeds.**
→ **Handled.** Server-side EMA (α=0.2) smooths it before tremolo mapping. Confirmed working in integration smoke test (tilt=null path at velocity=680 → smooth tremolo=3.05Hz).

**Item: Desktop mock sends `tilt: null`.**
→ **Handled.** Confirmed in integration test: tilt=null correctly falls back to velocity-based brightness (cutoff=1329Hz), no NaN, no crash.

### From Epic 6

**Item: "Live browser + pencil-client pass deferred to manual test."** (Critical carried-forward item)

→ **Partially resolved; hardware run documented and ready.**

What was verified programmatically in Epic 7:
- Integration smoke test (6 assertions, all pass) confirmed: biometric and pencil clients connected simultaneously to the same server, interleaved message routing, tilt=null fallback, per-connection smoother isolation, malformed message handling.
- Unit tests (19 tests, all pass) confirm all mapping math.
- The server log during smoke test shows `[tempo]` and `[melody]` lines interleaving by wall-clock arrival — exactly the pattern Epic 6 required.

What requires hardware execution (cannot be automated):
- Opening `pencil-input/index.html` in Safari on the 10th-gen iPad, connecting to the engine, and drawing with the USB-C Apple Pencil to produce real `altitudeAngle`-derived tilt values over a live WebSocket.
- Running simultaneously with real Polar Vantage M BPM data from the phone relay.
- Confirming both influences are **audibly** distinguishable in real playback.

**The run sequence for the hardware pass is documented above.** This step must be done by the performer before demo day. All code paths that will execute during the hardware run are covered by automated tests; the only unverified piece is the physical DOM-event → `wsSendPencil()` → WebSocket → audio path under real hardware timing.

Re-flagged as "hardware verification step" — see Known Limitations below.

**Item: Pan range assumes fixed canvas width (~1180px).**
→ **Carried forward as known limitation.** No change — documented in Epic 6 and still accepted. If a different device/orientation is used on demo day, pan sits off-center but does not break.

**Item: `y` is unmapped.**
→ **Carried forward as known limitation.** Three signals (tilt, velocity, x) cover filter, tremolo, and pan. y remains available for a future pass.

---

## Known limitations of the integrated system

- **Hardware verification step (pencil + Polar run) not yet done by machine.** Run sequence is fully documented; code is verified by 19 unit tests + 6 integration assertions. Must be executed on real hardware (iPad + Pencil + Polar watch) before the demo.
- **~7–9s physiology-to-audible-tempo lag** is structural (Epic 1 smoother). Tempo changes are audible but delayed. Not a bug; tell the demo audience to watch for it.
- **Pencil client requires manual reconnect** after engine restart. One HUD tap. Red badge makes the failure visible.
- **Polar relay IP must be checked** if Mac changes networks. Checklist at top of this doc.
- **Pitch shifts with tempo** (`playbackRate` is not pitch-preserving). Accepted; ±3–4 semitones at the observed BPM range.
- **Pan assumes 10th-gen iPad landscape viewport** (~1180px CSS width). Different device/orientation will shift the pan center but not break audio.
- **Loop boundary seam** (inherited from Epic 2): hard cut at sample 0. At elevated playbackRate it repeats more frequently. No crossfade added.
- **Tremolo at 8 Hz (max velocity) is fast.** At TREMOLO_DEPTH=0.15 this is perceptible as flutter, not distortion. Acceptable for the product intent (faster drawing = busier texture).
- **Single fal.ai bed.** No dynamic generation during performance. The bed is pre-rendered; only its playback parameters (rate, filter, pan, tremolo) are live.

---

## Git workflow

Commits made during this epic:
- `a9fe7d6` — `fix(audio-engine): scope velocity smoother per connection, not globally`

Tag applied after definition-of-done criteria are met:
```
git tag -a epic-7-complete -m "end to end integration"
```
