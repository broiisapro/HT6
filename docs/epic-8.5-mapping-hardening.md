# Epic 8.5 — Mapping Hardening: Rate Limiting, Mood Inversion, Dynamic/Static Mode

## Goal

Harden the existing biometric-to-tempo mapping (Epic 3) and pencil-to-melody mapping (Epic 6)
with three targeted fixes: a rate-of-change cap to eliminate jarring tempo lurches from sudden
sensor spikes, a runtime toggle to invert the mapping direction for a calmer-at-high-HR mood,
and a runtime freeze switch so the performer can lock the music at any moment during the demo.

## 2a — Rate-of-change limiting ("jumpscare fix")

### The gap

Epic 1 clamped BPM to 40–180 and smoothed it with `RollingBpmSmoother`. Epic 3 confirmed no
additional smoothing was needed at 1 msg/sec. Neither enforced *how fast* the effective BPM
driving the music is allowed to move per update. A genuine sudden spike — real fright, gasp,
or a motion-artifact glitch from the sensor — could still swing through the existing smoothing
window fast enough to cause an audible lurch rather than a graceful ramp.

### What was built

`createBpmRateLimiter(maxBpmPerSec)` in `audio-engine/src/biometric-mapper.js`:

- Stateful closure tracking `lastEffectiveBPM` and `lastUpdateMs`.
- On each biometric message: `effectiveBPM = lastBPM + clamp(targetBPM - lastBPM, -maxDelta, +maxDelta)`.
- `maxDelta = maxBpmPerSec × min(dt, 1.0)` — the 1-second dt cap prevents a huge single-step jump
  when resuming from static mode after a long pause.
- Applied **after** clamp, **before** mood inversion and rate calculation. Runs always (no toggle).

### Cap value: 10 BPM/sec — reasoning

| Criterion | Rationale |
|---|---|
| Musical feel | 10 BPM/sec ≈ 10% tempo change/sec at 96 BPM — comparable to a moderately fast ritardando/accelerando in live performance. |
| Spike protection | A 40 BPM startle spike ramps over ~4 seconds: still dramatic, clearly audible, but a smooth ramp not a lurch. |
| Range traversal | Full 50–130 BPM range (80 BPM span) at maximum speed traverses in ~8 seconds — graceful at demo scale. |
| Lower bound rejected | ≤5 BPM/sec: sluggish, performer loses sense of biometric connection. |
| Upper bound rejected | ≥20 BPM/sec: insufficient protection against sensor motion artifacts. |

### Before / after evidence (concrete, test-verified)

Scenario: BPM jumps from 72 to 122 in one 1-second update — a realistic motion-artifact spike.

**BEFORE (no rate limit):**
```
playbackRate 72/96 = 0.750  →  122/96 = 1.271
Δ playbackRate = 0.521 in one step — audible lurch
```

**AFTER (10 BPM/sec rate limiter):**
```
effective BPM: 72  →  82  (capped at +10 BPM)
playbackRate 72/96 = 0.750  →  82/96 = 0.854
Δ playbackRate = 0.104 in one step — graceful ramp (5× slower)
```

The spike then ramps to the target over the following ~5 updates:
```
update 1: 72 → 82  (playbackRate 0.854)
update 2: 82 → 92  (playbackRate 0.958)
update 3: 92 → 102 (playbackRate 1.063)
update 4: 102 → 112 (playbackRate 1.167)
update 5: 112 → 122 (playbackRate 1.271) ← fully arrived
```

Both before- and after-paths are verified by automated unit tests:
- `"jumpscare fix: BPM spike 72→122 without limiter would jump 0.521 rate in 1s"`
- `"jumpscare fix: BPM spike 72→122 WITH limiter ramps to only 82 BPM (0.104 rate change)"`

### Implementation path in server.js

```
incoming bpm
  → clampBpm()              ← Epic 3 range guard
  → rateLimiter()           ← Epic 8.5 rate cap (always on)
  → applyMoodInversion()?   ← Epic 8.5 optional
  → ÷ BED_BPM               ← playbackRate
```

The `[tempo]` server log line includes `(rate-limited from X.X)` when the cap fires, so the
operator can see the transformation chain in real time.

## 2b — Opposite-mood toggle

### What was built

`applyMoodInversion(clampedBPM)` in `audio-engine/src/biometric-mapper.js`:

```
invertedBPM = INPUT_MAX_BPM + INPUT_MIN_BPM − clampedBPM
```

This is a reflection about the midpoint of the clamped range `[50, 130]` — same underlying
mapping function, direction flipped. Applied after rate limiting, before dividing by `BED_BPM`.

**Concrete values:**

| Heart rate | Mode | Effective BPM | playbackRate | Perceived feel |
|---|---|---|---|---|
| 50 BPM (slow) | Normal | 50 | 0.521 | Slowest |
| 50 BPM (slow) | Inverted | 130 | 1.354 | Fastest |
| 96 BPM (mid) | Normal | 96 | 1.000 | Native tempo |
| 96 BPM (mid) | Inverted | 84 | 0.875 | Slightly below native |
| 130 BPM (fast) | Normal | 130 | 1.354 | Fastest |
| 130 BPM (fast) | Inverted | 50 | 0.521 | Slowest |

The output always stays within `[INPUT_MIN_BPM, INPUT_MAX_BPM]` — no additional clamping needed.
The inverted output range is identical to the normal range (`[0.521, 1.354]`) — just traversed
in the opposite direction. Musically coherent, not numerically nonsensical.

Pencil-to-melody mapping (filter/tremolo/pan) is **not** affected by mood inversion — the
inversion applies only to the BPM→tempo axis, consistent with the epic description.

### How to enable

Press **`o`** in the audio-engine terminal during a live session. Each press toggles between:
```
[mood] opposite mood ON  — high HR → calmer output
[mood] opposite mood OFF — normal mapping restored
```

State lives in `server.js` (`oppositeMoodEnabled` boolean). Programmatically:
```js
const { setOppositeMood } = startServer({ ... });
setOppositeMood(true);  // on
setOppositeMood(false); // off
```

### Verification

Automated tests in `test/mapper.test.js`:
- `applyMoodInversion: INPUT_MIN_BPM → INPUT_MAX_BPM` — confirmed direction inverted at extremes.
- `applyMoodInversion: midpoint maps to midpoint` — midpoint (90) is unchanged, as expected.
- `applyMoodInversion: result stays within [INPUT_MIN_BPM, INPUT_MAX_BPM]` — no range escape.
- `applyMoodInversion: double inversion is a no-op (round-trip)` — applying twice = identity.
- `applyMoodInversion: inverted mapping is still within playbackRate [0.52, 1.36]` — valid rates.

With toggle off: existing Epic 3 behavior unchanged — `bpmToPlaybackRate()` is not modified.
With toggle on: direction genuinely reversed and musically coherent (same rate range, opposite slope).

## 2c — Dynamic vs. static mode

### What was built

`staticModeEnabled` flag and `setStaticMode(bool)` in `server.js`. When static:

- **Biometric messages**: stale timer is reset (source is still live), but the message is not
  applied to `sourceNode.playbackRate`. The rate limiter state is also not updated.
- **Pencil messages**: pencil stale timer is reset (Pencil is still live), but cutoff/tremolo/pan
  are not updated.
- Music stays exactly at whatever parameter state it was in when static mode was engaged.

When switching back to dynamic:
- The next biometric message applies from the pre-freeze state.
- The rate limiter's dt cap (1 second) ensures the first post-freeze message can move at most
  10 BPM from the pre-freeze value — no jarring snap even if the performer's real HR has
  drifted during the freeze.
- The first pencil message resumes filter/tremolo/pan from wherever they were frozen.

### How to trigger

Press **`s`** in the audio-engine terminal:
```
[mode] static mode ON  — output frozen (live input ignored)
[mode] static mode OFF — resuming live control
```

Programmatically:
```js
const { setStaticMode } = startServer({ ... });
setStaticMode(true);  // freeze
setStaticMode(false); // resume
```

### Verification

- Static mode confirmed to block AudioParam writes: the server log shows `static mode — ignoring`
  entries for incoming messages while the music audibly stays at its frozen parameter state.
- Stale timers continue resetting in static mode: confirmed by code review (stale timer reset
  precedes the static-mode early-return check for biometric; same pattern for pencil).
- Transition back to dynamic is smooth: the dt-cap test `"dt is capped at 1s even after a long
  pause"` demonstrates that resuming after 30 seconds still limits to 10 BPM change, not 300.
- No interaction with Epic 8 fallback: fallbackPlayer.active check precedes the static check,
  so fallback mode takes priority (consistent with Epic 8's design intent).

## Key decisions and why

**Rate limiter always on, no toggle.** A configurable off-switch would require reasoning about
whether a given spike is "intentional" vs. artifact — not a call a performer can make in real
time. The limiter is transparent at normal physiological rates (≤10 BPM/sec physiological change
is rare) and a safety net at artifact rates.

**Mood inversion as reflection, not a separate mapping.** Inverting the same linear curve about
its midpoint keeps both modes in the same playbackRate range and means there's no possibility
of the inverted mode producing a musically incoherent output (e.g. silence, distortion). A
separate parallel mapping would require tuning and testing independently.

**Static mode freezes both biometric and pencil simultaneously.** A "freeze tempo only" or
"freeze melody only" variant was considered but rejected — partial freezes would be confusing
to the performer and the demo audience. One key, one state.

**Rate limiter state not reset on static-mode exit.** The pre-freeze `lastEffectiveBPM` is
preserved so the limiter can ramp gracefully from where it was. Resetting would discard the
performer's physiological baseline, potentially causing a larger jump.

**Pencil-mapper.js is unchanged.** Mood inversion only applies to the BPM→tempo axis. The
pencil's filter/tremolo/pan mapping has no "mood" analog that was requested.

## Known limitations

- **Static mode does not preserve AudioContext time.** If static mode is held for a very long
  time (minutes), the AudioContext clock still advances. This has no audible effect but means
  `setTargetAtTime` calls at resume will use a large `startTime` offset — handled correctly by
  the Web Audio spec but not explicitly tested.
- **Mood inversion pivot is fixed at midpoint.** The midpoint of `[50, 130]` is 90 BPM. At 96
  BPM (the native tempo), inverted mode plays at `84/96 = 0.875` rather than `1.0`. This is a
  deliberate tradeoff: a formula-preserving reflection keeps the code simple and the output range
  identical. If a performer expects "inverted 96 BPM = native tempo," this could be surprising.
- **Rate limiter is per-server-instance, not per-connection.** A single `createBpmRateLimiter()`
  instance is shared. If multiple biometric clients connect simultaneously (not a current use
  case), the limiter's state would interleave across sources. Acceptable for the demo's one-client
  design.
- **No visual/UI feedback for mode state.** The mode changes are logged to the terminal only.
  A demo operator watching the console can see the state; the performer cannot — they must count
  keystrokes or watch for an audible change.
- **'o' and 's' keys are new; 'f' still controls fallback.** If Epic 8's fallback is active when
  static mode is toggled, the fallback guard in server.js takes priority and messages are
  dropped before the static-mode check fires. Static mode is effectively irrelevant while
  fallback is active.

## Status

Tag `epic-8.5-complete` created on commit `d0db20c` (implementation) plus the documentation
commit immediately following. All 38 unit tests pass.
