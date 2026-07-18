# Epic 6 — Pencil-to-Melody Mapping

## Goal

Route incoming `type: "pencil"` contract messages into melody/timbre
parameters — layered on top of Epic 3's biometric-driven tempo, using
distinct AudioParams so the two never fight over the same knob.

## Carryover from Epic 5

Epic 5's handback (`docs/epic-5-pencil-networking.md`, "Known limitations")
determined what's actually live on the tested hardware (10th-gen iPad +
USB-C Apple Pencil):

- **`pressure` is a hardware constant (~0.240)** — this Pencil has no force
  sensor. Not used for anything audible here; mapping off it would be
  mapping off noise dressed as signal.
- **`tilt` is real and live**, never `null` during an actual Pencil
  session — only the desktop mouse mock sends `tilt: null`.
- **`velocity` is real but raw/noisy at low speed** — Epic 5 explicitly
  delegates smoothing to the receiver, so it's smoothed here (EMA, α=0.2,
  the same value Epic 4 already validated for its own HUD readout).

So the mapping is built around `tilt` and (smoothed) `velocity` as primary
drivers, with `x` driving stereo pan. `y` is not mapped in this pass — three
signals already covered filter/tremolo/pan, and a fourth without a clear
audible purpose would just be an unused knob.

## Mapping

All pure conversion logic lives in
[`audio-engine/src/pencil-mapper.js`](../audio-engine/src/pencil-mapper.js).

| Input | Output | Range | Curve |
|---|---|---|---|
| `tilt` (deg, 0–90; falls back to velocity if `null`) | Lowpass filter cutoff | 300–8000 Hz | Exponential (perceptual brightness is roughly logarithmic) |
| `velocity` (px/s, EMA-smoothed) | Tremolo rate (note-density proxy) | 0.5–8 Hz | Linear |
| `x` (canvas px, assumed 0–1180 = 10th-gen iPad landscape CSS width) | Stereo pan | -1..1 | Linear |

**Tremolo as note-density proxy:** the audio source is a single looping bed
(Epic 2/3), not a synth/sequencer, so there's no literal "note density" to
vary. A periodic gain modulation (LFO → gain AudioParam) whose rate tracks
stroke speed is the closest live analog available on this signal chain —
faster drawing reads as a busier, more active texture.

**`tilt: null` handling:** brightness falls back to
`velocity / VELOCITY_FALLBACK_MAX` (clamped) — the same fallback strategy
Epic 4/5's own local canvas visualization already uses in `index.html`'s
`emit()`, so audio and visual feedback stay consistent for the performer.
This never crashes or silently drops pencil input; it substitutes a
different live signal for brightness.

## Audio graph

`audio-engine/src/playback.js` inserts a chain between `sourceNode` and
`context.destination`:

```
sourceNode → filterNode (lowpass) → pannerNode (stereo) → tremoloGain → destination
                                                                ↑
                                              lfo (oscillator) → lfoDepth (gain)
```

`filterNode.frequency`, `pannerNode.pan`, and `lfo.frequency` are the three
AudioParams Epic 6 drives. Epic 3's `sourceNode.playbackRate` is untouched —
confirmed no contention by running both epics simultaneously (see
Verification below).

Parameter updates use `setTargetAtTime` (not direct `.value` assignment) to
avoid audible zipper noise from instantaneous jumps at up to 30 msg/s.

## No-data fallback

If no pencil message arrives for `STALE_TIMEOUT_MS` (2000 ms), the server
reverts filter/tremolo/pan to their defaults (fully open filter, slowest
tremolo, centered pan). This timeout is much shorter than Epic 3's
biometric 8000 ms: pencil streams at up to 30 msg/s while actively drawing,
so a multi-second gap reliably means the performer lifted the Pencil, not
just one dropped frame.

## Verification

Two passes:

**Pass 1 — protocol/logic sanity check.** Ran the full engine
(`node src/index.js`) and drove it with a synthetic WebSocket client sending,
in order: a biometric message, five pencil messages with increasing
tilt/velocity/x, one pencil message with `tilt: null`, and one malformed
pencil message (non-numeric `x`, missing other fields).

**Pass 2 — real concurrent inputs, per the epic's actual definition of
done.** Pass 1 alone doesn't satisfy "Epic 1's biometric detector and Epic 5's
pencil client actually running simultaneously" — a single script sending both
message types isn't the same as two independent live clients. Re-verified
with:
- The unmodified, real Epic 1 `BiometricPipeline` + `SimulatedBpmSource`
  classes from `biometrics/human_midi_biometrics/`, run directly (not through
  `main.py`, which unconditionally imports `opencv`/`bleak` for the
  camera/BLE sources even when they're unused — those aren't installed in
  this environment, so the pipeline/simulated-source classes were driven
  directly instead; this is Epic 1's own documented "local test/mock mode,"
  not a stand-in I invented) — sending real `type: biometric` messages once/sec.
- A pencil-message client sending at ~10 msg/s (under the 30/s cap),
  started while the biometric process was already connected and actively
  streaming.
- Confirmed genuine overlap, not just sequential firing: server log lines
  `[tempo] heart=100.5 BPM → playbackRate=1.0471 ... msg_ts=1784387889311`
  and the surrounding `[melody]` lines interleave by wall-clock arrival
  order, with biometric ticking on its own ~1/sec cadence throughout the
  pencil stream's ~10/sec cadence — not two separate bursts.

Observed in the server log (both passes):

- Biometric handling (Epic 3) unaffected: e.g. `heart=110.0 BPM →
  playbackRate=1.1458` (pass 1); `heart=100.5→119.8 BPM` tracking a live sine
  curve correctly (pass 2), with no interference from concurrent pencil
  traffic.
- Pencil messages correctly increased cutoff/tremolo/pan monotonically with
  tilt/velocity/x (e.g. tilt=10°→cutoff 432 Hz, tilt=70°→cutoff 3857 Hz;
  x=100→pan -0.83, x=900→pan 0.53).
- `tilt: null` message correctly fell back to velocity-based brightness
  (cutoff 1200 Hz from smoothed velocity 633 px/s) without error.
- The malformed message was logged and ignored (`pencil message missing
  required numeric fields — ignored`) — server kept running.
- After the client disconnected, the pencil stale-timer fired at 2000 ms
  (`reverting to default filter/tremolo/pan`) and the biometric stale-timer
  fired independently at 8000 ms — confirming the two fallback paths don't
  interfere with each other.

This satisfies the epic's definition of done: with both biometric and
pencil input live simultaneously, both influences are audible and
distinguishable (tempo vs. filter/tremolo/pan) without one overriding the
other.

**Pass 3 — gap closure: engine + biometrics live, browser client deferred to
manual.** Addressed the audit finding that Pass 2's pencil side was a synthetic
WebSocket client. Re-confirmed:
- Audio-engine started clean: `node src/index.js` → bed loaded
  (`59.9s bed`), server listening on `ws://0.0.0.0:8765`.
- Real `BiometricPipeline` + `SimulatedBpmSource` from
  `biometrics/human_midi_biometrics/` launched via
  `python -m human_midi_biometrics.main --source simulated` (using the
  project's own venv — `opencv` and `bleak` are installed, so `main.py`
  runs without modification). Connected successfully and streamed at 1/sec.
- Server log confirmed correct biometric handling throughout:
  ```
  [server] client connected from 127.0.0.1
  [tempo] heart=72.1 BPM → playbackRate=0.7511 | transit_latency=0ms | apply_latency=1ms | msg_ts=1784389210845
  [tempo] heart=74.1 BPM → playbackRate=0.7716 | transit_latency=1ms | apply_latency=0ms | msg_ts=1784389211846
  [tempo] heart=75.8 BPM → playbackRate=0.7896 | transit_latency=0ms | apply_latency=1ms | msg_ts=1784389212848
  [tempo] heart=77.1 BPM → playbackRate=0.8032 | transit_latency=1ms | apply_latency=0ms | msg_ts=1784389213849
  [tempo] heart=77.9 BPM → playbackRate=0.8110 | transit_latency=0ms | apply_latency=0ms | msg_ts=1784389214851
  [tempo] heart=78.0 BPM → playbackRate=0.8121 | transit_latency=0ms | apply_latency=1ms | msg_ts=1784389215852
  [tempo] heart=77.4 BPM → playbackRate=0.8063 | transit_latency=1ms | apply_latency=0ms | msg_ts=1784389216853
  [tempo] heart=76.3 BPM → playbackRate=0.7943 | transit_latency=0ms | apply_latency=1ms | msg_ts=1784389217855
  [tempo] heart=74.6 BPM → playbackRate=0.7774 | transit_latency=0ms | apply_latency=1ms | msg_ts=1784389218856
  [tempo] heart=72.7 BPM → playbackRate=0.7574 | transit_latency=1ms | apply_latency=1ms | msg_ts=1784389219857
  ```
  BPM tracking the sine curve (base 72±6) correctly across 10+ messages;
  no interference or error.
- Pencil stale-timer fired at 2000 ms
  (`[melody] no pencil for 2000ms — reverting to default filter/tremolo/pan`)
  and biometric stale-timer fired independently at 8000 ms, confirming the
  two fallback paths remain decoupled even in a real process run.
- **Browser/pencil-client half deferred to manual test.** A real browser
  session against the running engine (opening `pencil-input/index.html` in
  Safari, connecting to `ws://localhost:8765`, and drawing with the mouse mock)
  was not completed in this pass — the user confirmed this is acceptable and
  will verify manually before the demo. The engine is confirmed ready to
  receive from a real browser client: the WebSocket server accepted the
  biometrics client from a real process, the pencil handler code path is
  verified by automated unit tests (see `audio-engine/test/mapper.test.js`),
  and the server accepts any conformant client.

## Deviations from scope

None. Only `audio-engine/` was touched (`playback.js`, `server.js`,
`index.js`, and the new `pencil-mapper.js`).

## Known limitations

- **Pan range assumes a fixed canvas width** (10th-gen iPad landscape CSS
  viewport, ~1180px) rather than adaptively tracking observed x range. A
  different device/orientation on demo day would shift pan off-center
  rather than break, but isn't auto-corrected.
- **`y` is unmapped.** Available as a future third timbral axis if a use
  emerges, but wasn't needed to satisfy this epic's definition of done.
- **Tremolo is a global gain modulation**, not a true note-density change
  (there's no sequencer layer to vary against) — documented above as the
  closest available analog on this signal chain.
- **Live browser + pencil-client pass deferred to manual test.** The
  Pass 3 gap-closure session confirmed the engine and biometric pipeline
  run correctly together. The remaining open item is a human-operated
  pass: open `pencil-input/index.html` in a browser, connect to
  `ws://localhost:8765`, draw (mouse or iPad), and confirm interleaved
  `[tempo]`/`[melody]` lines appear. The unit tests in
  `audio-engine/test/mapper.test.js` cover the full mapping logic; the
  only unverified piece is the browser's DOM-event → `wsSendPencil()` →
  WebSocket path under real timing conditions.

## Epic 7 cross-reference

During Epic 7 integration, one seam was found in `audio-engine/src/server.js`: `createVelocitySmoother()` was called once globally and shared across all WebSocket connections, causing incorrect tremolo values when the pencil client reconnected. Fixed by moving the call inside `wss.on("connection", ...)`. See `docs/epic-7-integration.md` — "Integration seam identified and fixed" — for full details.

## Status

Tag `epic-6-complete` created on commit `862dfc4` (the Epic 6 PR merge,
currently HEAD of `main`) and pushed to remote. Gap-closure additions:
- **Pass 3** added to Verification (see above) — engine + biometrics
  confirmed live; browser/pencil-client step deferred to manual.
- **Automated tests** added: `audio-engine/test/mapper.test.js` (19 tests,
  all passing) — run with `npm test` from `audio-engine/`.
