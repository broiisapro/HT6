# Epic 3 — Biometric-to-Tempo Mapping

## Goal

Wire the live biometric BPM stream from Epic 1's pipeline into the audio
engine's looping bed so that an elevated heart rate audibly speeds up the
music and a resting heart rate slows it down — in real time, on real hardware,
with no silence or crash when biometrics are absent.

## Mapping curve

**Formula:**

```
playbackRate = clamp(heartBPM, 50, 130) / BED_BPM
```

where `BED_BPM = 96` — the exact tempo baked into the fal.ai generation
prompt used in Epic 2 (`"Tempo: 96 BPM"`). At `playbackRate = 1.0` the bed
plays at its native speed.

**Input clamp: 50–130 BPM.**
- Lower bound 50: covers genuinely slow resting heart rates without pushing
  playbackRate so low (<0.52) that the music loses rhythmic coherence.
- Upper bound 130: covers vigorous demo perturbation; values above this push
  playbackRate above 1.35, which audibly distorts the bed's pitch beyond
  what the product intent tolerates.
- These bounds are a second-layer safety net — Epic 1's pipeline already
  clamps outgoing BPM to 40–180 upstream.

**Sample values across the observed Polar Vantage M range:**

| Heart rate | playbackRate | Perceived effect |
|------------|-------------|-----------------|
| 70 BPM | 0.7292 | Clearly slower than native |
| 80 BPM | 0.8333 | Noticeably slower |
| 96 BPM | 1.0000 | Native bed tempo |
| 103 BPM | 1.0729 | Noticeably faster (peak observed in real test) |
| 108.8 BPM | 1.1333 | Clearly faster (Run 1 peak) |
| 130 BPM | 1.3542 | Maximum (clamp ceiling) |

In the real two-run test, playbackRate swung from **0.7292 (resting,
70 BPM)** to **1.0729 (elevated peak, 103 BPM)** — a **+43.8% speedup**
from resting to peak, observed as audible and confirmed by a human listener.

**Why linear over alternatives:**
At the ~1 msg/sec update cadence produced by Epic 1, a non-linear curve
(exponential, sigmoid) would compress or expand the musically interesting
sub-range without any perceptual benefit. Linear is predictable, reversible,
and easy to explain to a demo audience. The Polar range (77–103 BPM in real
use) maps to a 0.80–1.07 rate range — already a 34% swing, clearly audible
without amplification.

## Smoothing decision

**No additional smoothing added on top of Epic 1's existing smoother.**

Epic 1's pipeline already applies `RollingBpmSmoother(window_size=5)` for the
Polar relay path (window_size=6 for camera) and emits at ~1 msg/sec. In real
hardware testing (30+ messages across two Polar runs), successive smoothed BPM
values differed by ≤1.6 BPM per step (e.g. 70.0 → 70.5 → 70.67 → 71.0),
producing `playbackRate` increments of ≤0.017 per second — continuous,
gradient tempo motion with no audible step-function jitter. Adding an
additional EWA or moving average here would only delay tempo response
further. The observation that zero jitter appeared with direct per-message
application is documented in `audio-engine/src/biometric-mapper.js`.

## Measured end-to-end latency

### WebSocket message arrival → playbackRate applied

Measured by logging `rxTime = Date.now()` at message receipt and
`applyTime = Date.now()` after `sourceNode.playbackRate.value =` assignment.
Both processes (biometrics pipeline and audio engine) ran on the same Mac;
both timestamps used `Date.now()`.

Across **30 real messages from 2 real Polar hardware runs:**
- `transit_latency` (biometrics `timestamp` field → engine `rxTime`): **0–2ms**
- `apply_latency` (`rxTime` → playbackRate assigned): **0–1ms**
- **Total software contribution: < 3ms** from biometric message emit to
  playbackRate value set.

### Audio buffer render (engineering estimate)

`node-web-audio-api`'s native AudioContext renders audio in fixed-size
buffers. On macOS with default Core Audio configuration, buffer sizes are
typically 512–1024 samples at 44.1 kHz, giving a render latency of
~12–23ms. The playbackRate change takes effect at the next buffer boundary
after the value is set, adding an estimated **5–20ms** to the above software
figures. This is an engineering estimate for this sub-component based on the
runtime and platform, not a directly measured number.

**Combined software + audio render: < 25ms** from biometric message arriving
to the first affected audio samples reaching the output.

### Physiology-to-first-audible-step lag (~7–9 seconds)

Separately, the lag from the moment a physiological perturbation *starts*
(e.g. breath-hold begins) to the moment the music audibly steps up is
**~7–9 seconds**. This is a log-derived estimate, not a stopwatch-precise
measurement. The human tester confirmed changes were observable, and the
breakdown from the Run 2 log is:

| Component | Estimated contribution |
|-----------|----------------------|
| Polar watch HR broadcast interval | ~1s |
| Phone HTTP POST to Mac relay (LAN) | <50ms |
| RollingBpmSmoother fills (5 samples × 1s) | ~5s |
| Pipeline emit interval | ~1s |
| WebSocket transit + assignment | <3ms |
| Audio buffer render | ~5–20ms |
| **Total** | **~7–9s** |

This lag is **structurally owned by Epic 1's smoothing architecture**, not
by the audio engine. Reducing it would require lowering `window_size` in
`biometrics/human_midi_biometrics/smoothing.py`, which trades smoother
output for faster response — a biometrics/ decision, out of scope here.

## Findings from prior epics that affected this epic's approach

### From Epic 1 (`docs/epic-1-biometric-source.md`)

- **Primary source is Polar Vantage M via phone relay** (not phone-camera) —
  the relay IP must be current and the iPhone app must be running; the audio
  engine is source-agnostic and does not care which path is used.
- **BPM is already smoothed and clamped** before it arrives at the WebSocket.
  This epic did not need to duplicate that logic; the audio engine receives
  stable, bounded values.
- **~1 message/second emit cadence** — this set the upper bound on tempo
  modulation responsiveness and informed the no-data fallback timeout.
- **Observed real Polar range: 77–97.6 BPM in a calm 3-min run** (epic 1
  doc), extending to ~103 BPM during active perturbation in this epic's own
  hardware test. Both ranges produce clearly audible tempo swings with the
  linear curve.

### From Epic 2 (`docs/epic-2-audio-engine-scaffold.md`)

- **Tone.js was abandoned** — Tone.js throws `param must be an AudioParam`
  when used against `node-web-audio-api`'s native nodes (an interop gap with
  the `standardized-audio-context` package). Epic 2 rewrote playback against
  `node-web-audio-api` native nodes directly. This meant tempo control had to
  be implemented via `sourceNode.playbackRate.value`, **not**
  `Tone.Transport.bpm.value`. The original epic framing said "Tone.js
  transport" — that language was superseded by Epic 2's actual runtime choice.
- **BED_BPM = 96** — the generation prompt specified `"Tempo: 96 BPM"` and
  this is the `playbackRate = 1.0` anchor for all calculations.
- **`startPlayback()` returns `{ context, sourceNode }`** — this epic's server
  change accepts `sourceNode` and sets `sourceNode.playbackRate.value` on each
  biometric message. No changes to the playback module were needed.

## Key decisions and why

**Mapping curve (linear proportion):** See "Mapping curve" section above. The
alternative considered was an amplified or non-linear mapping; rejected because
the natural physiological range (70–110 BPM) already produces a large
(0.73–1.15) rate swing with linear scaling, making amplification unnecessary.

**Smoothing (none added):** See "Smoothing decision" section above. Adding
smoothing on top of an already-smoothed signal with a 1/sec cadence would
only add lag.

**No-data fallback timeout: 8,000ms.** Chosen as approximately 8 missed
updates at the ~1 msg/sec emit rate. Long enough to absorb brief WebSocket
reconnect gaps (the pipeline retries on disconnect with a 2s backoff) without
triggering false resets; short enough to recover cleanly when biometrics/ is
restarted mid-demo. The fallback reverts to `playbackRate = 1.0` (native
96 BPM), keeping music playing at a musically sensible default.

**`sourceNode.playbackRate.value` as the tempo-control mechanism:** Tone.js
was not reintroduced (see Epic 2 finding above). `playbackRate` is a single
property write — immediate, synchronous, no abstraction layer needed. The
known tradeoff is that it shifts pitch along with tempo (a stretched buffer
plays higher or lower pitched), accepted as-is per product decision.

**Pitch shift tradeoff accepted:** At the demo's observed BPM range (70–108
BPM), playbackRate spans 0.73–1.12×, producing approximately ±3–4 semitones
of pitch shift relative to the bed's generated key (A minor). This was an
explicit product decision — no phase-vocoder or pitch-preserving approach
was pursued.

## Deviations from scope

- **"Tone.js transport tempo" language in the roadmap/epic framing was
  superseded** by Epic 2's documented runtime decision to drop Tone.js
  entirely. Using `sourceNode.playbackRate.value` was the correct continuation
  of Epic 2's approach, not an unscoped deviation.
- **No changes to `biometrics/`** — the audio engine is purely a consumer of
  the existing contract.
- **No changes to `pencil-input/`** — pencil-message logging preserved
  exactly as in Epic 2.
- **No WebSocket contract changes** — the `{ type, bpm, timestamp }` shape
  was sufficient.
- **Filter/intensity modulation not implemented** — the epic framing mentioned
  "optionally filter cutoff/intensity." This was not pursued; only
  `playbackRate` is modulated. The `context` object returned by
  `startPlayback()` exposes `BiquadFilterNode` and `GainNode` for future use.

## Known limitations

- **Physiology-to-first-audible-step lag (~7–9s)** is dominated by Epic 1's
  `RollingBpmSmoother`. It is a characteristic of the system, not a defect
  of this epic's code, and cannot be reduced without modifying
  `biometrics/human_midi_biometrics/smoothing.py`.

- **Pitch shifts with tempo.** `AudioBufferSourceNode.playbackRate` is not
  pitch-preserving. Accepted as-is. If a future epic requires pitch-stable
  tempo modulation, a phase-vocoder Web Audio node would be needed.

- **Loop boundary seam** inherited from Epic 2. At elevated playbackRate the
  seam repeats more frequently. Still a hard cut at sample 0; a crossfade
  would require modifying `audio-engine/src/playback.js`.

- **⚠ PRE-DEMO CHECKLIST — Polar relay IP:** The iPhone relay app's ATS
  exception is scoped specifically to `100.66.157.100` (the Mac's LAN IP at
  the time of Epic 1's ATS hardening pass). **If the Mac's LAN IP changes
  before the actual demo (different network, DHCP lease, etc.), the iPhone
  app must be rebuilt with the new IP.** Check `ifconfig` or `ipconfig
  getifaddr en0` at demo setup time and compare against the ATS exception
  in the iPhone project's `Info.plist`. This is the only pre-demo step that
  requires an Xcode rebuild.

- **No WebSocket backpressure or reconnect handling on the engine side.**
  The biometrics pipeline reconnects automatically (2s retry loop); the
  engine server accepts whatever connects. No issues observed in testing, but
  worth revisiting if the demo involves repeated start/stop of the pipeline.
