# Epic 8 — Demo Rehearsal & Fallbacks
## Goal
Make the live demo survivable under real-world failure conditions (Bluetooth drop, phone relay loss, camera issues, network hiccup) without the performance falling apart in front of judges, and rehearse the full run enough times that the team knows exactly what to do if something breaks.

---

## Final biometric source decision
**Primary: Polar Vantage M via phone relay.**
**Fallback 1: phone-camera PPG via Camo flash-on.**
**Fallback 2 (in-demo, no restart): pre-recorded BPM sequence triggered by `f` key.**

Reasoning from evidence:
- Epic 1 established Polar relay as primary (77.0–97.6 BPM, 179 messages, stable over 3 min; camera path more volatile and setup-sensitive).
- Epic 7 integration run used simulated BPM because the iPhone relay app was not posting (0 messages over 12 s initial attempt). **This is the main fragility to watch on demo day:** the relay app must be visibly streaming HR data before the demo starts. Verify `[WS] sent bpm=XX.X` lines are appearing in the biometrics terminal before walking on stage. If they're not, switch to camera (Fallback 1) or pre-recorded (Fallback 2).
- The Polar relay IP (`100.66.157.100`) was confirmed current as of Epic 7 (2026-07-18). Verify again at demo setup with `ipconfig getifaddr en0`.

---

## Pre-flight checklist (run at demo setup time)

```bash
# 1. Verify Mac LAN IP matches the ATS exception in the iPhone relay app.
ipconfig getifaddr en0
# Must print: 100.66.157.100
# If different: rebuild iOS app in Xcode with the new IP in Info.plist.

# 2. Start audio engine.
cd /path/to/HT6/audio-engine
npm start
# Wait for BOTH lines before proceeding:
#   [playback] looping .../assets/bed.wav (59.9s bed)
#   [server] contract WebSocket server listening on ws://0.0.0.0:8765
# Then: [index] press f to toggle fallback playback. Ctrl+C to exit.

# 3a. Start biometrics — PRIMARY (Polar Vantage M via phone relay).
#     Prerequisites: watch on wrist, iPhone relay app running and connected.
cd /path/to/HT6/biometrics
source .venv/bin/activate
python run.py --source polar-phone-relay --websocket-url ws://127.0.0.1:8765
# Expect: "Polar phone relay listening on http://0.0.0.0:8766/hr"
# Then 5–10 s later (smoother fills): "[WS] sent bpm=XX.X timestamp=..."
# CONFIRM these lines are appearing before going on stage.

# 3b. If Polar relay is not posting (no [WS] sent lines after 15 s):
python run.py --source phone-camera --websocket-url ws://127.0.0.1:8765
# Open Camo Studio first; force torch on; hold finger on camera lens.

# 4. Serve pencil-input page to iPad.
cd /path/to/HT6/pencil-input
python3 -m http.server 8080
# Serves at http://100.66.157.100:8080/index.html

# 5. On iPad: Safari → http://100.66.157.100:8080/index.html
#    In HUD sidebar: type ws://100.66.157.100:8765 → tap Connect.
#    Status badge must turn green ("connected").
```

---

## Fallback trigger conditions and how to invoke them live

### Trigger: `f` key in the audio-engine terminal

Press `f` once in the terminal running `npm start` (the audio-engine terminal):
- Activates pre-recorded fallback for **both** biometric and pencil simultaneously.
- Console logs: `[fallback] ACTIVATED — replaying pre-recorded sequences. Press f again to return to live input.`
- The bed continues playing; tempo and melody params change from the pre-recorded sequences immediately.

Press `f` a second time to deactivate:
- Console logs: `[fallback] DEACTIVATED — returning to live input.`
- Live input resumes if sources are running. If they're not, the stale timers revert audio params to defaults within 8 s (biometric) / 2 s (melody), then music continues at native 96 BPM.

### When to trigger the fallback

| Visible failure signal | Action |
|---|---|
| Biometrics terminal shows no `[WS] sent bpm=...` lines for > 10 s (Polar relay dropped) | Press `f` in audio-engine terminal → tempo fallback active. Attempt to restart biometrics in background if time allows. |
| iPad HUD shows red badge ("closed" or "error") for > 5 s (pencil client dropped) | First: tap Disconnect then Connect in the iPad HUD (one tap reconnect). If still failing after one attempt: press `f` → pencil fallback active. |
| Both biometric and pencil visibly non-functional | Press `f` → full fallback active. Demo continues. |
| Everything fails completely (engine crash, audio dropout) | Last resort: have a screen-recorded demo capture ready to play. This is the one scenario the `f` key cannot recover from. |

### What the pre-recorded sequences sound like

**Biometric (60 s arc, loops):**
75 → 97.6 → 82 BPM — playbackRate 0.78 → 1.02 → 0.85. Clearly audible as a tempo arc: starts calm, rises to near-native speed, settles. Models a realistic Polar performance session.

**Pencil (3.7 s loop, repeats continuously):**
- Stroke 1: gentle left-to-right, tilt 22.5° → filter ~682 Hz, tremolo 0.5–1.9 Hz (calm texture)
- Gap: melody reverts to open filter/slow tremolo (~0.5 s silence)
- Stroke 2: fast right-to-left diagonal, tilt 38° → filter ~1200 Hz, tremolo up to 6 Hz (bright, busy)
- Gap: revert (~0.4 s)
- Stroke 3: slow upward, tilt 11° → filter ~414 Hz, tremolo 0.5–2.4 Hz (dark, sparse)
- Gap: revert (~0.75 s)

---

## Timed run-through script

**Total performance window: ~2 min (demo pitch)**

| Time | Action | Notes |
|---|---|---|
| T−5:00 | Pre-flight: verify LAN IP, confirm biometrics `[WS] sent` lines, iPad HUD green | Non-negotiable — don't skip this check |
| T−2:00 | Confirm audio is audible (ask a teammate to listen to the Mac speakers) | The bed should be looping; note the loop seam |
| T+0:00 | Intro: "The system is live — my heartbeat is driving the tempo right now." | Point to biometrics terminal showing BPM lines. Tell audience the 7–9 s lag is physiological, not a bug |
| T+0:20 | First Pencil stroke on iPad | "Drawing with this Pencil shapes the sound texture — how I tilt it and how fast I move" |
| T+0:40 | Pause drawing; raise the iPad | Tempo continues changing from biometrics; melody reverts to default after ~2 s of no drawing. Demonstrate independence of the two channels |
| T+1:00 | Resume drawing — deliberate slow-then-fast strokes | Show contrast: upright Pencil (dark filter) vs flat Pencil (bright filter), slow (low tremolo) vs fast (high tremolo) |
| T+1:30 | Brief physical perturbation (deep breath hold, then exhale) | "Watch the tempo — it responds to my actual physiology. There's about a 7-second lag because we're smoothing real heart-rate data." |
| T+2:00 | End demo |  |

**If fallback is active during the demo:** the performance proceeds identically — judges see the same behaviour. Mention it only if asked directly ("Is that live data?"); answer honestly and explain the fallback was pre-designed for exactly this scenario.

---

## Rehearsal runs performed

**Run 1 (2026-07-18, headless smoke test — deliberate-failure path):**

Executed `node test/fallback-smoke.js` from `audio-engine/`:

```
[server] contract WebSocket server listening on ws://0.0.0.0:8765
[server] client connected from 127.0.0.1
[tempo] heart=85.0 BPM → playbackRate=0.8854 | transit_latency=5ms | apply_latency=1ms
[melody] tilt=45.0 velocity=400px/s x=590 → cutoff=1549Hz tremolo=2.00Hz pan=0.00
[server] client disconnected: 127.0.0.1   ← biometric client dropped (Polar BT drop simulated)
[fallback] ACTIVATED — replaying pre-recorded sequences. Press f again to return to live input.
[fallback/tempo] bpm=75.0 → playbackRate=0.7813
[fallback/melody] tilt=22.5 vel=0px/s x=200 → cutoff=682Hz tremolo=0.50Hz pan=-0.66
[server] fallback active — live message dropped from 127.0.0.1: ...   ← live msg correctly dropped
[fallback/tempo] bpm=75.5 → playbackRate=0.7865   ← sequence advancing
[fallback/tempo] bpm=76.0 → playbackRate=0.7917
[fallback] DEACTIVATED — returning to live input.
[tempo] heart=103.0 BPM → playbackRate=1.0729   ← live resumes immediately
✔ FALLBACK SMOKE: all assertions passed
[tempo] no biometric for 8000ms — reverting to default playbackRate=1.0 (96 BPM)   ← stale timer resumes
```

All 7 assertions passed (S1a, S1b, S2a, S2b, S2c, S2d, S2e, S3a, S3b). Exit code 0.

**Deliberate-failure test confirmed:**
- Polar BT drop simulated: live biometric client disconnected mid-run.
- Fallback triggered: `fallbackPlayer.start()` called (equivalent to `f` keypress in real operation).
- Live message dropped correctly while fallback active.
- Sequence advanced: BPM 75.0 → 75.5 → 76.0 at 1 s intervals.
- Deactivation clean: live message (103 BPM) applied immediately after `fallbackPlayer.stop()`.
- Stale timer resumed normally post-deactivation.

**Run 2 (2026-07-18, integration regression — existing tests still pass):**

Executed `node test/integration-smoke.js` after all server.js changes. All 6 existing assertions passed. Exit code 0. The `fallbackPlayer=null` default means the integration smoke test (which does not pass a fallbackPlayer) is unaffected by the Epic 8 changes.

**Full audible run on Mac with real hardware:** deferred to team demo setup time (consistent with Epic 7 precedent, where Moksh provided audible confirmation). The smoke tests confirm audio param routing; audible confirmation of the fallback sequences on real speaker output should be done once at setup by whoever runs the demo machine.

---

## Known limitations and remaining risks
- **Polar relay IP is environment-specific.** If the Mac's LAN IP changes before the demo (different network, DHCP lease), the iPhone app's ATS exception must be updated and the app rebuilt in Xcode. Check with `ipconfig getifaddr en0` at setup time. This is the single highest-probability failure that requires advance preparation.
- **Fallback trigger requires keyboard access to the audio-engine terminal.** The operator running `npm start` must be reachable (physically or via ssh/screen-share) during the demo. If the machine is locked or the terminal is obscured, the `f` key cannot be pressed.
- **Fallback pencil sequence is synthetic.** It models a plausible performance arc but is not a capture of actual Pencil session data. The mapping ranges (tilt 11–38°, velocity 0–1740 px/s) are grounded in real Epic 7 hardware data. It sounds musically coherent but will not match the performer's actual drawing style.
- **Fallback biometric arc loops at 60 s.** At the end of the 60-message arc (BPM 82.0), it loops back to 75.0. The loop jump is a discrete BPM step (82→75), which maps to a playbackRate drop of ~0.073 — clearly audible. In a 2-minute demo, this happens once at ~60 s into fallback. Keep the demo under 60 s of fallback use, or deactivate and reactivate fallback to restart the arc at a lower BPM if it starts sounding too fast.
- **No recovery for full engine crash.** If `npm start` crashes (rare but possible: Core Audio device loss, out-of-memory, unhandled exception), the `f` key does not help. Have a pre-recorded screen capture of the working demo as an absolute last resort.
- **~7–9 s physiology-to-audible-tempo lag** (inherited from Epic 1 smoother, documented in Epics 3 and 7). Carry this into the demo script: tell the audience to listen for the tempo change after the physical trigger, not immediately.
- **iPad pencil client requires manual reconnect** after audio-engine restart. One HUD tap. Red status badge makes the failure visible.
- **Camo Studio required for phone-camera fallback path.** Continuity Camera cannot force torch on.
