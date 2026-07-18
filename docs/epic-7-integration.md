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

## Synthetic validation log (integration-smoke.js)

**Note:** The log below is from `audio-engine/test/integration-smoke.js` — a headless mock test
that stubs AudioParam/AudioNode and simulates WebSocket traffic without real hardware or Core Audio.
It verifies routing logic and the per-connection EMA fix, but is NOT a real hardware run.
The real hardware run log is in the section below.

The engine accepts WebSocket connections the moment the server binds (~100 ms after `npm start`).
The biometrics pipeline has a 2s reconnect loop, so starting it before the engine is safe — it retries
automatically. The pencil-input client connects manually via the HUD, so there's no race condition.

```
[server] contract WebSocket server listening on ws://0.0.0.0:8765
[server] client connected from 127.0.0.1          ← biometrics pipeline (mock)
[tempo] heart=85.0 BPM → playbackRate=0.8854 | transit_latency=1ms | apply_latency=0ms
[server] client connected from 127.0.0.1          ← pencil client (mock)
[melody] tilt=45.0 velocity=600px/s x=590 → cutoff=1549Hz tremolo=2.75Hz pan=0.00 | transit_latency=0ms | apply_latency=0ms
[tempo] heart=103.0 BPM → playbackRate=1.0729 | transit_latency=0ms | apply_latency=0ms   ← interleaved
[melody] tilt=null velocity=680px/s x=590 → cutoff=1329Hz tremolo=3.05Hz pan=0.00          ← null tilt fallback
[melody] tilt=45.0 velocity=2000px/s x=100 → cutoff=1549Hz tremolo=8.00Hz pan=-0.83       ← fresh EMA (second client)
[melody] no pencil for 2000ms — reverting to default filter/tremolo/pan   ← stale timer
[tempo] no biometric for 8000ms — reverting to default playbackRate=1.0 (96 BPM)           ← stale timer
```

All 6 integration-smoke.js assertions pass; both stale timers fire independently.

---

## Hardware run log (Epic 7b — 2026-07-18)

**Run conditions:**
- Wall-clock window: 2026-07-18 ~16:26–16:28 UTC (approx. 90s active measurement window within a
  longer session that included the earlier polar-phone-relay connection attempt)
- BPM source: `--source simulated` (Polar Vantage M relay attempted first for 12s; iPhone relay
  app was not posting — 0 BPM messages received — so simulated was used as documented fallback)
- Pencil client: real 10th-gen iPad at LAN IP `100.66.74.136`, Safari, Apple Pencil (USB-C),
  connected via the on-page HUD to `ws://100.66.157.100:8765`
- HTTP server: `python3 -m http.server 8080` serving `pencil-input/index.html` on Mac

**Real startup log (audio-engine):**
```
[playback] looping /Users/moksh/Code/HT6/audio-engine/assets/bed.wav (59.9s bed)
[server] contract WebSocket server listening on ws://0.0.0.0:8765
```

**Real interleaved engine log (excerpt — full run produced 91 [tempo] + 104 [melody] lines):**
```
[server] client connected from 127.0.0.1           ← simulated biometrics pipeline
[tempo] heart=72.0 BPM → playbackRate=0.7504 | transit_latency=0ms | apply_latency=0ms | msg_ts=1784392021422
[tempo] heart=74.0 BPM → playbackRate=0.7709 | transit_latency=1ms | apply_latency=1ms | msg_ts=1784392022423
[tempo] heart=75.8 BPM → playbackRate=0.7891 | transit_latency=0ms | apply_latency=0ms | msg_ts=1784392023425
[tempo] heart=78.0 BPM → playbackRate=0.8122 | transit_latency=1ms | apply_latency=0ms | msg_ts=1784392026427
...                                                ← 91 [tempo] lines total at ~1/sec
[server] client connected from 100.66.74.136       ← real iPad (Apple Pencil, USB-C)
[melody] tilt=35.9 velocity=0px/s x=455 → cutoff=1111Hz tremolo=0.50Hz pan=-0.23 | transit_latency=110ms | apply_latency=4ms
[melody] tilt=35.9 velocity=194px/s x=501 → cutoff=1111Hz tremolo=1.23Hz pan=-0.15 | transit_latency=74ms | apply_latency=0ms
[melody] tilt=33.7 velocity=589px/s x=605 → cutoff=1024Hz tremolo=2.71Hz pan=0.02 | transit_latency=48ms | apply_latency=1ms
[melody] tilt=30.9 velocity=791px/s x=658 → cutoff=925Hz tremolo=3.47Hz pan=0.12 | transit_latency=48ms | apply_latency=1ms
[tempo] heart=77.7 BPM → playbackRate=0.8089 | transit_latency=0ms | apply_latency=1ms | msg_ts=1784392102534   ← interleaved
[melody] tilt=30.1 velocity=1382px/s x=498 → cutoff=900Hz tremolo=5.68Hz pan=-0.16 | transit_latency=47ms | apply_latency=1ms
[melody] tilt=29.1 velocity=1436px/s x=310 → cutoff=866Hz tremolo=5.88Hz pan=-0.47 | transit_latency=46ms | apply_latency=0ms
[tempo] heart=75.2 BPM → playbackRate=0.7833 | transit_latency=0ms | apply_latency=1ms | msg_ts=1784392104537
[melody] tilt=26.9 velocity=1459px/s x=523 → cutoff=802Hz tremolo=5.97Hz pan=-0.11 | transit_latency=47ms | apply_latency=1ms
[melody] tilt=39.0 velocity=1167px/s x=386 → cutoff=1246Hz tremolo=4.88Hz pan=-0.35 | transit_latency=56ms | apply_latency=0ms
[tempo] heart=73.4 BPM → playbackRate=0.7642 | transit_latency=1ms | apply_latency=0ms | msg_ts=1784392105538
[server] client disconnected: 100.66.74.136        ← iPad mid-session disconnect (HUD reconnect test)
[server] client connected from 100.66.74.136       ← iPad reconnected
[melody] no pencil for 2000ms — reverting to default filter/tremolo/pan   ← stale timer fired during gap
[tempo] heart=69.5 BPM → playbackRate=0.7234 | transit_latency=1ms | apply_latency=0ms | msg_ts=1784392107541
[melody] tilt=24.3 velocity=0px/s x=577 → cutoff=729Hz tremolo=0.50Hz pan=-0.02   ← FRESH EMA: vel=0 on 1st stroke
[melody] tilt=24.3 velocity=221px/s x=624 → cutoff=729Hz tremolo=1.33Hz pan=0.06  ← velocity building up naturally
[melody] tilt=24.3 velocity=463px/s x=665 → cutoff=729Hz tremolo=2.23Hz pan=0.13
[melody] tilt=23.0 velocity=978px/s x=779 → cutoff=694Hz tremolo=4.17Hz pan=0.32  ← fast stroke, high tremolo
[melody] tilt=27.8 velocity=2071px/s x=455 → cutoff=828Hz tremolo=8.00Hz pan=-0.23 ← max tremolo at high speed
[melody] tilt=8.8 velocity=1825px/s x=277 → cutoff=414Hz tremolo=7.34Hz pan=-0.53  ← pencil near-vertical: dark filter
[melody] tilt=42.2 velocity=469px/s x=822 → cutoff=1398Hz tremolo=2.26Hz pan=0.39  ← pencil flat: bright filter
```

**Observed ranges during real hardware run:**
- playbackRate: 0.6875 – 0.8125 (simulated BPM cycling 66–78, clearly audible tempo range)
- Filter cutoff: 414 Hz – 1398 Hz (pencil tilt 8.8°–42.2°; 3.4× brightness range)
- Tremolo rate: 0.50 Hz – 8.00 Hz (velocity 0–2331 px/s)
- Pan: −0.78 – +0.40 (x positions 130–827 CSS px across the iPad canvas)
- LAN transit latency (iPad → Mac): 46–112 ms
- Apply latency (parse + mapping): 0–4 ms
- No crashes, no unhandled exceptions in any terminal

**Per-connection EMA fix confirmed in real hardware:**
After the mid-session iPad disconnect/reconnect, the first pencil message shows `velocity=0px/s`
(EMA initialised null → returns raw on first call). Subsequent messages ramp up naturally
(221→463→748→978 px/s). If the old global smoother had been left in place, the first post-reconnect
message would have blended with the final velocity (~1400 px/s) from the previous session,
producing a falsely elevated tremolo at reconnect start.

**Stale timers confirmed independent:**
When the iPad disconnected mid-session, the 2000ms pencil stale timer fired (`reverting to default
filter/tremolo/pan`) while biometric [tempo] lines continued uninterrupted on their 1/sec cadence.

**Audible confirmation (Moksh, 2026-07-18):**
- Tempo change was clearly audible as simulated BPM cycled up and down.
- Reconnect behavior confirmed clean: mid-session HUD disconnect triggered the stale timer revert,
  then fresh drawing resumed normally with no stale-state tremolo jump.

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

→ **Substantially resolved in Epic 7b hardware run (2026-07-18).**

What was verified in the Epic 7b hardware run:
- Real 10th-gen iPad at LAN IP `100.66.74.136` connected to the live engine via Safari.
- Real Apple Pencil (USB-C) produced `altitudeAngle`-derived tilt values (8.8°–42.2°) over the
  live WebSocket — real Pencil data, not mouse mock (which would send `tilt: null`).
- Real mid-session disconnect and reconnect tested by the performer via the HUD button.
- 104 `[melody]` lines confirmed in the engine log, interleaved with 91 `[tempo]` lines.
- Per-connection EMA fix confirmed: `velocity=0px/s` on first post-reconnect stroke (fresh smoother).
- DOM-event → `wsSendPencil()` → WebSocket → server path confirmed working under real hardware timing.

What still requires human-sensory confirmation (audible, cannot be logged):
- That the tempo change was perceptible by ear (playbackRate 0.69–0.81 is a 17% range, which
  should be clearly audible as a tempo swing on the bed).
- That the filter/tremolo/pan changes were perceptible by ear as distinct from the tempo.
- Polar Vantage M (real HR) was not used in this run (simulated BPM). Real Polar HR verification
  deferred — see "Known limitations".

**Item: Pan range assumes fixed canvas width (~1180px).**
→ **Carried forward as known limitation.** No change — documented in Epic 6 and still accepted. If a different device/orientation is used on demo day, pan sits off-center but does not break.

**Item: `y` is unmapped.**
→ **Carried forward as known limitation.** Three signals (tilt, velocity, x) cover filter, tremolo, and pan. y remains available for a future pass.

---

## Known limitations of the integrated system

- **Audible confirmation received (Moksh, 2026-07-18).** Tempo change clearly audible as BPM
  cycled. Reconnect clean: stale timer reverted, fresh strokes resumed normally. Tag
  `epic-7-hardware-verified` applied.
- **Real Polar HR not used in this run.** BPM source was simulated (Polar relay attempted, iPhone
  app not posting). The Polar relay code path was confirmed connected (logged) but inactive. A
  full Polar-watch run is deferred to demo-day setup verification.
- **~7–9s physiology-to-audible-tempo lag** is structural (Epic 1 smoother). Tempo changes are
  audible but delayed. Not a bug; tell the demo audience to watch for it.
- **Pencil client requires manual reconnect** after engine restart. One HUD tap. Red badge makes
  the failure visible. Mid-session disconnect/reconnect confirmed clean in hardware run.
- **Polar relay IP must be checked** if Mac changes networks. Checklist at top of this doc.
- **Pitch shifts with tempo** (`playbackRate` is not pitch-preserving). Accepted; ±3–4 semitones
  at the observed BPM range.
- **Pan assumes 10th-gen iPad landscape viewport** (~1180px CSS width). Different device/orientation
  will shift the pan center but not break audio.
- **Loop boundary seam** (inherited from Epic 2): hard cut at sample 0. At elevated playbackRate
  it repeats more frequently. No crossfade added.
- **Tremolo at 8 Hz (max velocity) is fast.** At TREMOLO_DEPTH=0.15 this is perceptible as
  flutter, not distortion. Acceptable for the product intent (faster drawing = busier texture).
- **Single fal.ai bed.** No dynamic generation during performance. The bed is pre-rendered; only
  its playback parameters (rate, filter, pan, tremolo) are live.

---

## Git workflow

Commits made during Epic 7:
- `a9fe7d6` — `fix(audio-engine): scope velocity smoother per connection, not globally`
- `ef47d1e` — `docs(epic-7): integration doc, cross-reference, and smoke test`

Commits made during Epic 7b (hardware verification):
- (this doc update commit) — `docs(epic-7): replace synthetic smoke-test log with real hardware run evidence`

Tag `epic-7-complete` points at `ef47d1e` (the smoother fix + docs).
Tag `epic-7-hardware-verified` applied after audible confirmation from Moksh (2026-07-18).
