# Presage SmartSpectra — Third Layer (Stress-Driven Drive/Tension)

**Goal:** add Presage Technologies' SmartSpectra contactless vitals SDK as a
genuinely new third control layer, alongside heart-rate-driven tempo (Epic 3)
and pencil-driven melody/timbre (Epic 6) — not a redundant alternate bpm
source. A stress signal, derived from Presage's HRV reading, becomes its own
signal driving its own DSP control, running simultaneously with the other
two, none of them fighting over the same knob.

## Why bpm alone wasn't the point

An earlier pass at this treated Presage purely as another way to get a bpm
number (competing with the watch/phone-camera for the same contract field).
That's not a "layer on top of" pencil and watch — it's a duplicate tempo
source. SmartSpectra also outputs **HRV as RMSSD** (see the correction
section below — not a pre-computed stress index, as first assumed), which is
a genuinely different signal from pulse rate, so this is what actually makes
it additive: heart rate still drives tempo, pencil still drives
melody/timbre, and a stress value derived from RMSSD now drives a third,
independent control.

## What the third layer controls, and why

`stress` (0.0 calm – 1.0 tense) drives a dry/wet crossfade around a soft-clip
"drive" effect in `audio-engine/src/playback.js` — see
`audio-engine/src/stress-mapper.js` for the full rationale. Chosen over
reverb because it needs no impulse-response asset (reverb would need another
committed audio file); chosen as a crossfade over a dynamically-regenerated
waveshaper curve because regenerating a curve every ~1/sec message is
wasteful and can click.

## Contract change (flagged, per contracts/README.md Rule 1)

The `biometric` message gained one new optional field:

```json
{ "type": "biometric", "bpm": 72, "stress": 0.42, "timestamp": 1737000000000 }
```

`stress` is `null` for every source except Presage (phone-camera, Polar never
populate it) — `audio-engine/` treats a null/missing stress exactly like "no
Presage source running" and reverts the drive mix to fully dry, same
no-data-fallback convention as the other two layers.

## Integration approach: subprocess/relay bridges, not a Python or Swift SDK written from scratch

SmartSpectra ships official SDKs for **Kotlin, Swift, C++17, and
Node.js/Electron only** — no Python bindings, no documented plain REST
endpoint. Two paths were built, mirroring how Epic 1 already solved the exact
same shape of problem for the Polar watch (direct BLE vs. phone-relay of the
official example app):

- **`presage_cli.py`** (`biometrics/human_midi_biometrics/sources/presage_cli.py`,
  `--source presage-cli`): for a webcam plugged into the machine running
  `biometrics/`. Runs the installed C++/Node SmartSpectra example app as a
  subprocess, parses its stdout for pulse-rate and HRV (RMSSD) lines via
  regex.
- **`presage_phone_relay.py`** (`.../sources/presage_phone_relay.py`,
  `--source presage-phone-relay`): for running SmartSpectra on an **iPhone**.
  Rather than write custom Swift against an SDK nobody on the team has
  experience with — the same stack-mismatch risk `00-architecture.md`
  already flagged once for Pencil input — this runs Presage's own official
  iOS example app (or a light patch of it) and has it POST readings to
  `POST /bpm` with `{"bpm": <number>, "hrv_rmssd_ms": <number|omitted>}`,
  exactly mirroring `polar_phone_relay.py`.

Both implement the same `BiometricSource` interface, now extended with an
optional `get_stress()` (default `None` — only the Presage sources override
it). No existing source's behavior changed.

## Correction: the real metric is HRV RMSSD, not a "stress index"

An earlier pass assumed SmartSpectra outputs a pre-computed "Baevsky Stress
Index" (this appears in Presage's marketing copy). Checked against Presage's
actual iOS quickstart sample code
(`Presage-Security/SmartSpectra` repo, `swift/docs/option-1-api-key.md`), the
real SDK object is `metrics.cardio.hrv.last.rmssd` — a raw HRV RMSSD number in
milliseconds, with no separate stress-index field. RMSSD runs the *opposite*
direction from a stress index: **lower RMSSD means more stressed, higher
means calmer**. Both Presage sources have been corrected to expect RMSSD
(field/pattern renamed from `stress_index`/`stress_pattern` to
`hrv_rmssd_ms`/`hrv_pattern`) and to invert it before normalizing into the
contract's `stress` field. `rmssd_min_ms`/`rmssd_max_ms` (15-100, an
unverified placeholder adult resting range) replace the earlier
`raw_stress_min`/`raw_stress_max` (50-300) guess.

## iOS setup (verified from Presage's own repo)

Confirmed prerequisites for the iPhone path specifically: a **physical
iPhone** (SmartSpectra's iOS SDK doesn't support the simulator — it needs a
real camera) and **Xcode, which requires a Mac**. Steps (from
`swift/README.md` and `swift/docs/option-1-api-key.md` in
github.com/Presage-Security/SmartSpectra):

1. Register at the Presage Developer Admin Portal → verify email → get API key.
2. Xcode: File → New → Project → iOS → App, name "Cool Vitals", SwiftUI, Swift.
3. File → Add Package Dependencies → `https://github.com/Presage-Security/SmartSpectra-Swift/`, pin an exact released version (e.g. `3.0.0`).
4. Add Info.plist key "Privacy - Camera Usage Description".
5. Replace `ContentView.swift` with Presage's sample code, substituting the real API key for `YOUR_API_KEY`.
6. Build/run on a physical iPhone; grant camera access; wait a few seconds for camera auto-tuning.

The sample app then displays live pulse rate, breathing rate, HRV RMSSD,
expression score, and waveforms. From there, the remaining work is either
patching this sample app (or finding an existing export/relay hook in it) to
POST `{"bpm": <pulse rate>, "hrv_rmssd_ms": <rmssd>}` to
`presage_phone_relay.py`'s `/bpm` endpoint — see that file's docstring for the
exact contract.

## What's done vs. genuinely open

**Done:**
- `stress` added to the contract as an optional, nullable field.
- `BiometricSource.get_stress()` added (default `None`); `pipeline.py` includes
  `stress` in the outgoing payload, normalized/clamped to 0.0-1.0.
- Both Presage sources (`presage-cli`, `presage-phone-relay`) implemented,
  wired into `main.py`, corrected to use real HRV RMSSD with proper inversion.
- `audio-engine/src/stress-mapper.js` + `playback.js`'s dry/wet drive chain +
  `server.js`'s message handling and independent stale-timer, all tested
  end-to-end with real audio nodes and a real WebSocket message (verified:
  `stress: 0.8` → `dryGain=0.20 wetGain=0.80`, `bpm` unaffected).
- The iOS build/run sequence, verified against Presage's actual repo docs
  (not guessed).

**Open — requires a real device/account to finish, left explicit rather than
guessed:**
- **API key.** Register at physiology.presagetech.com; SmartSpectra requires
  it before any example app will run, on any platform.
- **A Mac to build the iOS app.** This dev environment is Windows; handed off
  to a teammate on a Mac (see prompt file for that handoff, if one exists
  alongside this doc).
- **Patching/relaying from the sample app.** The Cool Vitals sample app
  displays metrics on-screen but doesn't POST them anywhere by default —
  someone needs to add the relay POST call (or find/use an existing export
  hook) inside `ContentView.swift`.
- **RMSSD normalization range.** `rmssd_min_ms`/`rmssd_max_ms` (15-100) are an
  unverified placeholder — recalibrate against real readings once the app is
  running.
- No hands-on hardware/API test has been run (no API key available while
  building this). Everything downstream of "a real Presage source is
  emitting real numbers" (contract shape, pipeline, audio-engine mapping) has
  been verified; the sensor-facing edge has not.

## Recommendation

Once an API key is obtained and the Cool Vitals app is running on a real
iPhone (see iOS setup above): add a POST call inside `ContentView.swift`
sending `{"bpm": ..., "hrv_rmssd_ms": ...}` to this machine's
`presage_phone_relay.py` endpoint (`http://<mac-lan-ip>:8767/bpm`), then
adjust `rmssd_min_ms`/`rmssd_max_ms` against real readings before trusting
the demo mapping.
