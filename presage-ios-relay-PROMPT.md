# Presage iOS Relay — Handoff Prompt

**For:** the teammate picking this up on a Mac (Xcode is required — this
can't be done on Windows). Paste this whole block as the first message to
your coding agent.

---

You're continuing work on Human MIDI, a live-performance app where a
performer's heart rate controls music tempo and Apple Pencil input controls
melody/timbre, both layered over a pre-generated instrumental bed. A third
control layer is being added: a stress signal (from Presage Technologies'
SmartSpectra contactless vitals SDK, running on an iPhone) that drives a
drive/distortion "tension" effect, independent of tempo and melody.

**Branch:** `feature/presage-biometric-source` — check it out first
(`git fetch && git checkout feature/presage-biometric-source`). All the
work described below as "already done" lives there.

## What's already done (don't redo this)

- **Contract** (`contracts/README.md`): the `biometric` message has a new
  optional field, `stress` (0.0 calm – 1.0 tense, `null` for sources that
  don't produce it).
- **`biometrics/human_midi_biometrics/sources/presage_phone_relay.py`**: a
  local HTTP server (`PresagePhoneRelaySource`, default port 8767) that
  listens for `POST /bpm` with JSON body
  `{"bpm": <number>, "hrv_rmssd_ms": <number|omitted>}`, smooths both,
  inverts+normalizes RMSSD into the contract's `stress` field (lower RMSSD =
  higher stress), and feeds the existing WebSocket pipeline. Wired into
  `main.py` as `--source presage-phone-relay`.
- **`audio-engine/`**: `stress-mapper.js` + a dry/wet soft-clip drive node
  wired into the playback chain in `playback.js`, applied in `server.js` with
  its own independent stale-timer. This has been tested end-to-end with a
  real WebSocket message (`stress: 0.8` → `dryGain=0.20, wetGain=0.80`) and
  works correctly. **You should not need to touch `audio-engine/` at all.**
- Full writeup, including what was verified vs. guessed, and the exact iOS
  build steps (from Presage's own repo docs, not invented): see
  `docs/presage-biometric-source.md`.

## What's genuinely left to do

1. **Get a Presage API key.** Register at physiology.presagetech.com, verify
   email, grab the key from the developer portal.
2. **Build the SmartSpectra iOS example app ("Cool Vitals")** on a physical
   iPhone (the SDK does not support the simulator). Exact steps are in
   `docs/presage-biometric-source.md`'s "iOS setup" section — summarized:
   new Xcode SwiftUI project named "Cool Vitals" → add
   `https://github.com/Presage-Security/SmartSpectra-Swift/` as a Swift
   Package Manager dependency (pin an exact version tag) → add a camera-usage
   Info.plist entry → replace `ContentView.swift` with Presage's sample code,
   substituting your real API key → build/run on the physical device.
   **Confirm it's actually reading pulse rate and HRV RMSSD live before
   moving on** — don't proceed to step 3 on faith.
3. **Add a relay POST call inside `ContentView.swift`.** The stock sample app
   only displays metrics on-screen; it doesn't send them anywhere. Find where
   it reads `metrics.cardio.pulseRate.last` and `metrics.cardio.hrv.last.rmssd`
   (see the sample code) and add a lightweight periodic POST (every ~1s is
   fine — the pipeline downstream doesn't need faster) to
   `http://<mac-lan-ip>:8767/bpm` with body
   `{"bpm": <pulse rate>, "hrv_rmssd_ms": <rmssd>}`. Standard `URLSession`
   POST is enough — no need for a networking library.
   - `<mac-lan-ip>` is whatever machine is running `presage_phone_relay.py`;
     that script logs the exact URL to use on startup
     (`"Point the iPhone app's relay target at: http://<ip>:8767/bpm"`).
   - The iPhone and that machine need to be on the same local network/Wi-Fi.
4. **Verify end-to-end.** Run
   `python -m human_midi_biometrics.main --source presage-phone-relay --mock`
   from `biometrics/` first (confirms bpm/stress print locally without
   needing a live audio-engine), then point it at a real `audio-engine`
   instance with `--websocket-url ws://<audio-engine-host>:8765` and confirm
   the drive effect audibly changes as you stress yourself out / calm down
   in front of the phone.
5. **Recalibrate `rmssd_min_ms`/`rmssd_max_ms`** in
   `PresagePhoneRelayConfig` (currently 15/100, an unverified placeholder)
   against the real RMSSD values you observe on the Cool Vitals screen at
   rest vs. under stress, so the `stress` value actually spans a useful
   0.0-1.0 range for your specific readings.

## Explicitly out of scope

- Any change to `audio-engine/` — the stress-driven drive effect is done and
  tested; this task is purely getting real numbers flowing into it.
- The `presage-cli` (laptop webcam) source — separate, already-implemented
  path, not what this task is about.
- OAuth setup (Presage's "Option 2") — use the faster API-key path (Option 1)
  for this hackathon.

## Definition of done

Standing in front of the iPhone running Cool Vitals, with `biometrics/`'s
`presage-phone-relay` source and a real `audio-engine` both running: visibly
raising your stress (e.g. rapid movement, tension) audibly increases the
drive/distortion effect within a few seconds, and calming down audibly
reduces it back toward clean — verified live, not assumed from code reading.

## Documentation

Update `docs/presage-biometric-source.md`'s "What's done vs. genuinely open"
section to move whatever you complete from "open" to "done", and record the
real RMSSD range you calibrated against. Don't create a new docs file.

## Git workflow

Commit on `feature/presage-biometric-source` as you go (small, focused
commits — Conventional Commits style, matching the rest of this repo's
history). Don't merge to `main` yourself; hand back when the definition of
done above is met.
