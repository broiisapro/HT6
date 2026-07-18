# Human MIDI — Architecture Doc

**Project:** Your heartbeat controls the tempo of a live generative music bed; Apple Pencil pressure/velocity shapes melody/timbre on top; performed live at Hack the 6ix.
**Team:** 3 people, each running their own coding agent in parallel against a shared repo.
**Timeframe:** 36 hours.

## Stack

- **Biometrics (`biometrics/`):** two sources built and tested within one epic (Epic 1), not staged as a maybe-later bonus. Phone camera PPG (finger over camera + flash) — Python, OpenCV, red-channel intensity extraction, peak detection for BPM — is the fallback known to have no hardware-support uncertainty. Polar Vantage M is attempted for real against the actual watch, via whichever integration path testing shows actually works (options: Polar's official BLE SDK example app relayed over local network, or a direct cross-platform BLE read from the dev machine — both are genuinely unverified for this watch model, so the epic investigates rather than assumes). Both sources sit behind one common interface producing the same contract-shaped message, so nothing downstream needs to know or care which source is live. Epic 1's handback documents which source(s) actually work — that finding, not a decision made now, is what determines what's used going forward.
- **Audio engine (`audio-engine/`):** one MacBook running Node.js, hosting a WebSocket server and a Tone.js/Web Audio playback + DSP engine. This is the only component that talks to both other modules — see Contract below.
- **Music bed:** generated once via a fal.ai audio/music model, before the demo, cached as a committed audio file. Not generated live — real-time full AI music composition isn't practically reliable for a live demo today. Biometrics and Pencil input control DSP parameters (tempo, filter, layer volume) over this pre-rendered bed in real time.
- **Pencil input (`pencil-input/`):** Safari web app on the 10th-gen iPad, capturing Apple Pencil touch events — pressure (`force`), XY position, velocity (derived from position deltas over time), tilt/altitude as a bonus where available. Web-based rather than native PencilKit — see decision below.
- **Contract (`contracts/`):** one shared WebSocket message schema. `biometrics/` and `pencil-input/` are pure clients that send messages; `audio-engine/` owns the WebSocket server and all message handling. Neither client folder is ever touched by anyone but its owner, and nobody touches `audio-engine/` except its owner — this is what lets three people build in parallel without merge conflicts.

## Key decisions & why

1. **Web-based Pencil capture, not native PencilKit.** No confirmed Swift/Xcode skill on the team; native iOS dev was flagged repeatedly as a stack-mismatch risk across every Apple-native idea considered earlier. Cost: weaker tilt/altitude data than PencilKit would give. Mitigation: design the mapping so pressure + velocity carry the primary signal, tilt is additive polish only.
2. **Pre-rendered fal.ai bed + live DSP control, not live AI composition.** Real-time generative music models aren't there yet for a live, on-stage demo. The AI contribution is real (fal.ai generates the actual bed you'll perform over) but happens before the demo, not during it — be explicit about this distinction if a judge asks, per the earlier grilling notes.
3. **Both sources are built and tested for real, in the same epic — Polar is not ruled out ahead of time.** Phone-camera PPG has no dependency on unverified watch-model BLE support and no Bluetooth-in-a-crowded-room risk, so it's the safe fallback. But whether Polar works is an empirical question the epic answers by actually trying it against the real hardware, not a guess made in planning. Epic 1's handback — what actually worked, under what conditions — is the source of truth for what the rest of the project builds on, not this doc.
4. **Single WebSocket contract, one owner.** Both client modules send fire-and-forget JSON messages to `audio-engine`'s server. Audio-engine is the only component with shared-surface responsibility; everyone else's code lives entirely inside their own folder.

## Non-obvious constraints

- BLE is unreliable in a hackathon venue packed with devices — relevant to the Polar path specifically, not to phone-camera PPG. This is exactly why Epic 1 must test Polar for real rather than assume it'll behave the same in a crowded room as it did in a quiet test.
- The full latency chain — camera frame capture → peak detection → BPM → WebSocket → Tone.js parameter change — should be measured end to end early (Epic 3), not assumed to feel instant. Heart rate itself also ramps over several seconds after a physical trigger (e.g. jumping), which affects how the live demo should be paced.
- The fal.ai bed generation call must happen well before the demo and the resulting audio file must be committed to the repo — the live demo must not depend on a generation API call succeeding on stage.
- Safari's Pencil tilt/altitude support varies by WebKit version — verify what's actually available on the specific 10th-gen iPad being used, early (Epic 4), not assumed.

## Docs convention

One file per epic at `docs/epic-N-slug.md`, written by whoever closes out that epic, per the Orchestrator playbook's documentation convention. No other files under `docs/` unless explicitly needed for a genuinely cross-cutting decision, in which case it goes in this architecture doc instead.
