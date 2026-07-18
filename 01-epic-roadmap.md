# Human MIDI — Epic Roadmap

**Related:** [00-architecture.md](./00-architecture.md)

Every epic below is fully scoped (not just Title/Goal/Dependencies) — the team asked for maximum precision up front rather than deferring scoping until each epic's turn, which is a deliberate deviation from the playbook's minimum-scoping default for epics beyond Epic 1.

## Roadmap table

| # | Title | Owner | Folder | Depends on |
|---|---|---|---|---|
| 0 | Contract & Scaffolding | Orchestrator (Cris) | `contracts/`, repo root | — |
| 1 | Biometric Source: Phone-Camera PPG + Polar Vantage M | Person A | `biometrics/` | 0 |
| 2 | Audio Engine Scaffold + fal.ai Bed | Person B | `audio-engine/` | 0 |
| 3 | Biometric-to-Tempo Mapping | Person B | `audio-engine/` | 1, 2 |
| 4 | Pencil Capture (local only) | Person C | `pencil-input/` | 0 |
| 5 | Pencil Client Networking | Person C | `pencil-input/` | 4, 0 |
| 6 | Pencil-to-Melody Mapping | Person B | `audio-engine/` | 3, 5 |
| 7 | End-to-End Integration | Whole team | all folders | 1, 3, 5, 6 |
| 8 | Demo Rehearsal & Fallbacks | Whole team | all folders | 7 |

**Parallelization:** after Epic 0 closes, Epics 1, 2, and 4 start simultaneously — one per person, one folder each, zero overlap. Epic 1 now covers both biometric sources (phone-camera and Polar), so it's a heavier epic than before — budget more time for Person A accordingly, and don't let Epics 2/4 wait on it, since neither depends on which source Epic 1 ends up recommending. Epic 3 and 5 are each a single person continuing their own track. Epic 6 is Person B again (audio-engine stays single-owner throughout). Epics 7–8 are the only non-parallel, whole-team phases.

---

## Epic 0 — Contract & Scaffolding

**Goal:** Establish the one shared surface (WebSocket message contract) every other epic builds against, so Epics 1, 2, and 4 can start in parallel with zero risk of conflicting on shared code.
**Dependencies:** none.
**Carryover:** none — first epic.
**Deliverables:** `contracts/README.md` documenting the WebSocket message schema (see [02-epic0-contract-scaffolding.md](./02-epic0-contract-scaffolding.md) for the full content); repo skeleton with `biometrics/`, `audio-engine/`, `pencil-input/`, `contracts/`, `docs/` folders created; root `README.md` linking to the architecture doc.
**Explicitly out of scope:** any actual implementation code in any of the three module folders — this epic only creates structure and the contract doc.
**Definition of done:** contract doc committed and readable; folder skeleton exists; every teammate has pulled the repo and confirmed they can see their own folder.
**Docs artifact:** `docs/epic-0-contract-scaffolding.md`.
**Tracking sync:** n/a for this project (no Asana in use for the hackathon itself — noting the deviation here since the team requested the full playbook; recommend using the Cowork task list already tracking these epics as the practical equivalent, since Asana provisioning isn't warranted for a 36h build).
**Git marker:** `git tag -a epic-0-complete -m "contract and scaffolding"`.

---

## Epic 1 — Biometric Source: Phone-Camera PPG + Polar Vantage M

**Goal:** Two working biometric input paths, both tested against real hardware, both producing the same contract-shaped message — phone-camera PPG as the fallback known to have no hardware-support uncertainty, and the Polar Vantage M attempted for real, not assumed working or ruled out ahead of time. This epic's handback is the source of truth for what the rest of the project builds on — it decides what gets used later, not a prior assumption.
**Dependencies:** Epic 0 (contract).
**Carryover:** none.
**Deliverables:**
- Camera capture loop (OpenCV), red-channel intensity extraction, peak detection producing a smoothed BPM estimate — the phone-camera path, built to work standalone regardless of how the Polar path turns out.
- A real, hands-on attempt to get live HR off the actual Polar Vantage M. Investigate both plausible integration paths rather than assuming one: (a) a direct cross-platform BLE read from the dev machine (e.g. Python's `bleak` library) attempting to read the standard BLE Heart Rate Service while the watch is in a workout/broadcast state, and (b) using Polar's official open-source BLE SDK's example app (github.com/polarofficial/polar-ble-sdk has ready-made iOS/Android example apps built for exactly this) run on a phone, relaying BPM to the biometrics service over local HTTP/WebSocket if the direct route doesn't pan out. Try the simpler path first, document what was actually tested and what happened — success, partial success (e.g. connects but data is unreliable), or failure, with the specific error/limitation encountered.
- One common interface both sources implement, so a single "source" concept produces the contract message regardless of which is live — the rest of the system never needs to know which one is running.
- A WebSocket client sending `{"type": "biometric", "bpm": <number>, "timestamp": <number>}` per the contract, at roughly once per second, from whichever source(s) are confirmed working.
- A local test/mock mode independent of a live audio-engine connection.
**Explicitly out of scope:** any audio-engine code; any UI beyond basic local debug visualization; building a full production-grade native mobile app for the Polar path — if the SDK's example app needs a light modification to relay data, that's in scope, but a polished companion app is not.
**Definition of done:** phone-camera path produces a stable BPM reading within 40–180bpm that responds visibly to breath-holding or light movement, verified end to end via the WebSocket contract. Polar path has been genuinely attempted against the real watch and the result is documented either way — working, partially working (state exactly what's unreliable), or not working (state exactly what was tried and where it failed). This epic is not done if Polar was skipped or assumed rather than tested.
**Docs artifact:** `docs/epic-1-biometric-source.md` — the signal-processing approach for phone-camera PPG; the exact Polar integration path(s) attempted and the outcome of each; which source(s) are recommended for the demo and why; calibration notes for demo day.
**Tracking sync:** Cowork task list, moved to done in the same pass as the git tag.
**Git marker:** `git tag -a epic-1-complete -m "biometric source: phone-camera PPG + polar vantage m"`.

---

## Epic 2 — Audio Engine Scaffold + fal.ai Bed

**Goal:** A running audio engine on the Mac that hosts the contract WebSocket server and plays a pre-generated fal.ai instrumental bed on loop — no biometric or pencil control yet, just the foundation.
**Dependencies:** Epic 0 (contract).
**Carryover:** none.
**Deliverables:** Node.js project with a WebSocket server listening per the Epic 0 contract (accepting but not yet acting on messages — log them for now); a one-time script that calls a fal.ai music/audio generation model, saves the output as a committed audio file in `audio-engine/assets/`; a Tone.js/Web Audio playback setup that loops this file continuously.
**Explicitly out of scope:** any actual biometric or pencil-driven modulation (Epics 3 and 6); UI beyond whatever's needed to confirm playback is running.
**Definition of done:** running the engine plays the fal.ai-generated bed on loop; a test WebSocket client can connect and see its messages logged server-side; the generated audio file is committed to the repo (not regenerated at demo time).
**Docs artifact:** `docs/epic-2-audio-engine-scaffold.md` — which fal.ai model was used, the prompt, and why; the WebSocket server's shape for future epics to build on.
**Tracking sync:** Cowork task list.
**Git marker:** `git tag -a epic-2-complete -m "audio engine scaffold and fal.ai bed"`.

---

## Epic 3 — Biometric-to-Tempo Mapping

**Goal:** Incoming `type: biometric` messages actually change the music — BPM maps to tempo (and optionally filter/intensity), live.
**Dependencies:** Epic 1 (real BPM messages to test against), Epic 2 (engine to modify).
**Carryover:** read Epic 1's `docs/epic-1-biometric-source.md` handback before starting — it states which source(s) actually work and which is recommended for the demo. This epic's mapping logic should be source-agnostic by design (both sources emit the same contract shape), but test against whichever source Epic 1 confirmed as reliable, and flag it explicitly here if Epic 1's findings suggest anything that changes this epic's approach (e.g. if Polar turned out unreliable specifically under motion, don't assume the mapping tuning that works for phone-camera also suits Polar's noise profile).
**Deliverables:** a mapping function from BPM range to Tone.js tempo/filter parameters; smoothing so the music doesn't jitter on every noisy BPM reading; the full latency chain (camera → BPM → WebSocket → audible change) measured and documented.
**Explicitly out of scope:** pencil-driven changes (Epic 6); this epic only handles the biometric message type.
**Definition of done:** with Epic 1's detector actually running and a finger on the camera, physically changing your state (holding breath, brief movement) produces an audible, correct-direction tempo change within a few seconds — measured, not assumed.
**Docs artifact:** `docs/epic-3-biometric-tempo-mapping.md` — the mapping curve chosen and why, measured latency numbers.
**Tracking sync:** Cowork task list.
**Git marker:** `git tag -a epic-3-complete -m "biometric to tempo mapping"`.

---

## Epic 4 — Pencil Capture (local only)

**Goal:** A Safari web app on the iPad that captures Apple Pencil pressure, XY position, and velocity, visualized locally — no networking yet, just validating the data is good.
**Dependencies:** Epic 0 (contract, for reference — this epic doesn't send messages yet, but should structure its data to match the contract shape from the start).
**Carryover:** none.
**Deliverables:** a web page with a canvas capturing Pencil touch events; extraction of `force` (pressure), x/y position, velocity (computed from position deltas over time), and tilt/altitude if available on this specific iPad's WebKit version (test and document whether it's actually present — don't assume); a simple local visualization (e.g. a line whose thickness/color responds to pressure) to sanity-check the data live while drawing.
**Explicitly out of scope:** any networking/WebSocket client code (Epic 5); any audio-engine code.
**Definition of done:** drawing on the iPad with the Pencil visibly changes the local visualization in response to pressure changes in real time; a written note on whether tilt/altitude data was actually available on this hardware, since the architecture doc flagged this as unverified.
**Docs artifact:** `docs/epic-4-pencil-capture.md` — confirmed data fields available on this specific iPad, with the tilt-availability finding explicit.
**Tracking sync:** Cowork task list.
**Git marker:** `git tag -a epic-4-complete -m "pencil capture local"`.

---

## Epic 5 — Pencil Client Networking

**Goal:** The validated local Pencil data from Epic 4 now streams to the audio-engine over the contract WebSocket.
**Dependencies:** Epic 4, Epic 0.
**Carryover:** the tilt-availability finding from Epic 4 — if tilt isn't available, this epic sends `tilt: null` per the contract, not a fabricated value.
**Deliverables:** WebSocket client sending `{"type": "pencil", "pressure": <number>, "x": <number>, "y": <number>, "velocity": <number>, "tilt": <number|null>, "timestamp": <number>}` per the contract, at a reasonable rate (throttled to avoid flooding — e.g. max ~30 messages/sec even if touch events fire faster).
**Explicitly out of scope:** any audio-engine code (that's Epic 6).
**Definition of done:** drawing on the iPad produces a live stream of correctly-shaped messages, verified against a logging test client, at a sane rate that doesn't flood the connection.
**Docs artifact:** `docs/epic-5-pencil-networking.md`.
**Tracking sync:** Cowork task list.
**Git marker:** `git tag -a epic-5-complete -m "pencil client networking"`.

---

## Epic 6 — Pencil-to-Melody Mapping

**Goal:** Incoming `type: pencil` messages shape melody/timbre live, layered on top of the biometric-driven tempo from Epic 3.
**Dependencies:** Epic 3 (tempo mapping already working, so this adds on top rather than conflicting), Epic 5 (real pencil messages to test against).
**Carryover:** confirm Epic 5's message format and rate match what this epic assumes, including the possible `tilt: null` case — handle it gracefully, don't crash or silently ignore pencil input when tilt is absent.
**Deliverables:** a mapping from pressure/velocity/position (and tilt, if present) to melody/timbre parameters (e.g. filter cutoff, note density, layer volume) distinct from the tempo parameters Epic 3 already owns, so the two don't fight each other.
**Explicitly out of scope:** any pencil-input or biometrics code — this epic only touches `audio-engine/`.
**Definition of done:** with both Epic 1's biometric detector and Epic 5's pencil client actually running simultaneously, both influences are audible and distinguishable at the same time — heartbeat driving tempo, pencil driving melody/timbre, without one silently overriding the other.
**Docs artifact:** `docs/epic-6-pencil-melody-mapping.md`.
**Tracking sync:** Cowork task list.
**Git marker:** `git tag -a epic-6-complete -m "pencil to melody mapping"`.

---

## Epic 7 — End-to-End Integration

**Goal:** All three real components running together for the first time as one system, seams fixed.
**Dependencies:** Epics 1, 3, 5, 6 all complete.
**Carryover:** every open question flagged across Epics 1–6's docs gets resolved or explicitly re-flagged here — nothing silently dropped.
**Deliverables:** a single run sequence (documented, reproducible) that starts audio-engine, biometrics, and pencil-input together and produces a working live performance; tuning pass on the mapping parameters from Epics 3 and 6 now that they're interacting with real, simultaneous input instead of tested in isolation.
**Explicitly out of scope:** new features — this epic is integration and tuning only, not new capability.
**Definition of done:** fresh start of all three components → live finger-on-camera BPM and live Pencil drawing simultaneously and audibly shape the music, running continuously for at least several minutes without crashing or drifting out of sync.
**Docs artifact:** `docs/epic-7-integration.md` — the run sequence, and every tuning change made from the isolated-testing values.
**Tracking sync:** Cowork task list.
**Git marker:** `git tag -a epic-7-complete -m "end to end integration"`.

---

## Epic 8 — Demo Rehearsal & Fallbacks

**Goal:** The actual live demo is rehearsed, timed, and has a fallback for every fragile step identified across this whole project.
**Dependencies:** Epic 7.
**Carryover:** the specific fragility points already flagged earlier in this project — wrist PPG motion artifacts, BLE unreliability in a crowded room, latency in the biometric response — get an explicit fallback each, not just a hope they don't happen.
**Deliverables:** a pre-recorded fallback BPM/pencil data stream that can substitute for either live input if something fails on stage; a timed run-through script for the actual pitch; the final call on which biometric source(s) run live in the demo, made from Epic 1's tested findings and Epic 7's integration experience — not decided in advance.
**Explicitly out of scope:** any new features.
**Definition of done:** the team has run the full demo live, start to finish, at least twice without intervention, and has tested what happens when Bluetooth/network hiccups mid-demo (the fallback actually gets exercised once, not just written).
**Docs artifact:** `docs/epic-8-demo-rehearsal.md` — the fallback trigger conditions and how to invoke them live if needed.
**Tracking sync:** Cowork task list.
**Git marker:** `git tag -a epic-8-complete -m "demo rehearsal and fallbacks"`.
