# Epic 9 — Music-Type Classification

## Goal
Classify the live performer state (biometric BPM + pencil velocity) into one of
three mood categories, each backed by a distinct pre-rendered stem, crossfading
smoothly as the classified state changes — layered on top of, not replacing,
Epic 3/6's continuous tempo/melody modulation.

## Mood categories and thresholds

### Category definitions
All thresholds are grounded in Epic 1's actual observed BPM data:
- Polar Vantage M calm 3-min run: **77.0–97.6 BPM** (primary demo source)
- Polar perturbed: up to **~103 BPM**
- Camera PPG flash-on: **52.93–118.63 BPM** (wider, noisier)

| Category | effectiveBpm range | Stem character |
|---|---|---|
| **calm** | < 80 BPM | Dark, mellow — LPF at 700 Hz over bed.wav |
| **energetic** | 80–96 BPM | Full-range — the original bed.wav |
| **tense** | ≥ 96 BPM | Bright, edgy — highshelf +10 dB at 2 kHz |

Threshold rationale:
- **80 BPM (calm/energetic)**: the Polar calm-run floor is 77 BPM. Setting the
  boundary at 80 means the system stays in ENERGETIC for the bulk of a real Polar
  session (77–97.6 BPM), switching to CALM only when the performer genuinely rests.
- **96 BPM (energetic/tense)**: equals `BED_BPM`, the natural midpoint, and aligns
  with the top of Polar's calm range (97.6 BPM). Above 96 the performer is entering
  the perturbation zone — the intended TENSE trigger.

### effectiveBpm formula
```
effectiveBpm = rateLimitedBpm + (smoothedPencilVelocity / 1500) * 8
```
Pencil velocity adds 0–8 BPM equivalent, so fast energetic strokes can nudge the
system toward ENERGETIC or TENSE even when BPM alone sits at a boundary.

## Stems

### Source
Three WAV files committed to `audio-engine/assets/`:
- `stem-calm.wav` — LPF at 700 Hz applied offline via `OfflineAudioContext`
- `stem-energetic.wav` — verbatim copy of `bed.wav`
- `stem-tense.wav` — highshelf +10 dB at 2 kHz applied offline

All stems share the same native **96 BPM** tempo so `bpmToPlaybackRate()` continues
to work unchanged on top of whichever stem is active.

### Upgrade path
If a `FAL_KEY` is available before the demo, run:
```bash
FAL_KEY=xxx npm run generate-stems
```
This replaces the EQ-derived files with genuinely distinct fal.ai compositions:
CALM (ambient piano/pad), ENERGETIC (original bed prompt), TENSE (cinematic
dissonant ostinato). The rest of the system is unchanged.

### Model chosen
`CassetteAI/music-generator` — same as Epic 2. Reasons: simple `{prompt, duration}`
input, 60 s output, A minor / 96 BPM expressible in prompt, fast generation. No
alternative model was evaluated since Epic 2 already validated this choice and
the offline-processed stems work for the demo without any fal.ai call.

## Crossfade
**Duration: 3 seconds** (`CROSSFADE_DURATION_SEC = 3`).

All three stems loop simultaneously (silent until active). On a mood switch,
`linearRampToValueAtTime` ramps the outgoing stem's GainNode gain from its current
value to 0, and the incoming stem's gain from 0 to 1, both over 3 s. Interrupted
crossfades cancel and restart from the current gain value — no clicks.

3 s chosen: long enough for a human ear to notice the blend rather than a hard
cut (~2 s minimum), short enough not to feel sluggish during a 2-min demo window.

## Hysteresis

**Dead-band: ±4 BPM** (`HYSTERESIS_BPM = 4`).

Effective thresholds with hysteresis:

| Transition | Triggers when effectiveBpm | Reverts when effectiveBpm |
|---|---|---|
| CALM → ENERGETIC | ≥ 84 (80+4) | — |
| ENERGETIC → CALM | < 76 (80−4) | — |
| ENERGETIC → TENSE | ≥ 100 (96+4) | — |
| TENSE → ENERGETIC | < 92 (96−4) | — |

**Dwell time: 2 seconds** (`DWELL_MS = 2000`).

Signal must stay past the boundary for 2 continuous seconds before committing the
switch. If it returns to the current mood's territory before 2 s, the pending switch
is cancelled. Combined with the 5 BPM/sec rate cap (Epic 8.5), a motion-artifact
spike can never trigger a spurious mood switch — the ramp physically cannot reach the
threshold + hysteresis + dwell time requirements before decaying.

## Epic 8.5 rate-of-change limiter

Added to `biometric-mapper.js` as `createBpmRateLimiter(maxBpmPerSec = 5)`.

A sudden spike (gasp, fright, motion artifact) gets ramped at 5 BPM/second instead
of jumping instantly. At the ~1 msg/sec biometric cadence this caps any single step
to 5 BPM (∆playbackRate ≈ 0.052). Real Polar data showed ≤1.6 BPM/step in normal
use, so the limiter is invisible during normal operation.

Before the change: a 30 BPM spike applied immediately → audible lurch + instant
mood reclassification. After: 6-second ramp → graceful tempo drift + controlled
classification advance.

## Composition with Epic 8.5 toggles

**Static mode (key: `s`):**
When `liveState.staticMode = true`, the server drops both biometric and pencil
parameter updates entirely — no tempo change, no melody change, no classification
advance. The current mood stem continues playing at its frozen state. Pressing `s`
again resumes live control immediately.

**Opposite-mood toggle (key: `m`):**
When `liveState.oppositeMood = true`, the mood that would normally be selected by
the classifier is inverted via `MOOD_INVERSE`:
- CALM → TENSE stem
- TENSE → CALM stem
- ENERGETIC → ENERGETIC stem (unchanged — it is the middle mood)

The classifier still runs normally (tracking the actual biometric state), but the
stem that plays is the inverse. This means the music gets calmer as the performer's
heart rate rises, and more tense as it falls.

## Audio graph

```
stem-calm     → stemGain[calm]     ─┐
stem-energetic → stemGain[energetic]─┼→ filterNode → pannerNode → tremoloGain → destination
stem-tense    → stemGain[tense]    ─┘
                                     ↑
                          lfo → lfoDepth (Epic 6 tremolo, unchanged)
```

All three stems and the shared Epic 6 filter/tremolo chain run simultaneously.
`setPlaybackRate(rate)` updates all three source nodes at once so tempo modulation
from Epic 3 applies correctly regardless of which stem is active.

## Key decisions

**EQ-derived stems as default (not fal.ai):** generating distinct fal.ai stems
requires a `FAL_KEY` that wasn't available at implementation time. The offline
processor (`prepare-stems.js`) creates genuinely distinguishable audio from the
existing `bed.wav` (dark/mellow vs. full-range vs. bright/edgy) using no external
deps or accounts. The upgrade path to real fal.ai compositions is one command
(`npm run generate-stems`) whenever the key is available.

**All stems at same native BPM (96):** keeping all stems at 96 BPM means the
`bpmToPlaybackRate()` formula and all Epic 3 code remain unchanged. Tempo
differentiation comes from the live BPM modulation on top, not from the stem.

**Classifier default: energetic:** the original bed character is energetic, and the
system should start sounding like the original demo before any classification has
had time to run.

**No direct CALM↔TENSE transition:** classification steps through ENERGETIC. In
practice a signal can't jump directly from 70 BPM to 103 BPM at the 5 BPM/sec rate
cap — it must pass through the ENERGETIC zone anyway.

**Fallback does not reclassify:** when `fallbackPlayer.active` is true, the server
drops all live messages, so the classifier does not advance. The mood stem that was
active at fallback activation continues playing. This is consistent: fallback already
freezes tempo/melody, freezing the mood stem too.

## Known limitations

- **EQ-derived stems are the same musical content** with different timbres. For the
  most compelling demo, run `npm run generate-stems` with a `FAL_KEY` to get
  genuinely distinct musical material per mood.
- **Offline stems are 60 s at 48 kHz stereo** (~11 MB each). Compressed alternatives
  could reduce asset size if needed.
- **Static mode freezes classification** — if `s` is pressed while pending a mood
  switch (past boundary, dwell not expired), the dwell timer is paused and resumes
  when static mode is released.
- **Crossfade not interrupted cleanly if two quick switches occur within 3 s.** The
  second crossfade cancels and restarts from current gain values (no click), but the
  first stem may not fully fade before the second starts. Musically acceptable for
  the demo's 2 min window.
- **`generate-stems.js` has not been run** (no `FAL_KEY` at implementation time).
  The committed stems are offline EQ variants. Test audibly before the demo; if the
  distinction feels too subtle, run `generate-stems` or adjust the EQ parameters in
  `prepare-stems.js`.
