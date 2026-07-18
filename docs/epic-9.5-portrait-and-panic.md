# Epic 9.5 — Performance Portrait + Panic Mode

## Goal
Add two small, independently-toggleable performer tools on top of the existing
pipeline: a post-performance fal.ai image portrait seeded by real session data,
and a manually-triggered "big moment" intensity spike. Both degrade gracefully —
neither is required for the core demo to work.

## Performance Portrait (key: `r`)

### How it works
A `SessionTracker` accumulates statistics throughout the live session:
- BPM min/max (from the rate-limited signal, after `createBpmRateLimiter`)
- Time spent in each mood category (calm / energetic / tense)
- Pencil stroke count and average velocity
- Number of panic-mode activations

When the performer presses `r` in the audio-engine terminal, `generatePortrait()`
is called with a snapshot of the session data. It builds a prompt from the data
and fires `fal-ai/flux/schnell` asynchronously — the call does not block or
affect live audio in any way.

### Portrait prompt structure
The prompt encodes:
- Heart rate arc (min–max BPM)
- Dominant mood and per-category percentages
- Pencil activity (stroke count, average velocity in px/s)
- Panic mode count (if any)
- A mood-specific color palette (calm=teal/indigo, energetic=jade/amber, tense=crimson/orange)

Example prompt for an energetic-dominant session:
> *"Abstract generative art portrait of a live biometric music performance.
> Heart rate arc: 78–103 BPM. Dominant mood: energetic (calm 12%, energetic 71%,
> tense 17%). 34 pencil gestures at avg 420 px/s velocity.
> Color palette: vibrant jade green, warm amber, electric cyan, golden yellow.
> Style: flowing biometric data visualization, generative art, data portrait…"*

### fal.ai model choice
**`fal-ai/flux/schnell`** (FLUX.1 Schnell):
- Generates in ~2–4 s on the fal.ai queue — fast enough for a post-performance
  moment without losing audience attention
- FLUX.1 Dev was also considered but slower queue with no visible quality delta
  at presentation scale (projected on a second screen)
- SDXL ruled out: slower and heavier, with less aesthetic coherence on abstract
  data-art prompts in our testing

### Fallback behavior
`portrait-fallback.svg` is committed and shown immediately when 'r' is pressed.
This is the "something to show the audience" while the API call completes.
When the portrait saves to `assets/portrait-latest.png`, the terminal prints
the path for the operator to open immediately.

If `FAL_KEY` is not set: the fallback is announced and no API call is made.
If the API call fails: the fallback path is re-printed.

The performance continues entirely unaffected — `generatePortrait()` fires and
forgets; there is no await, no blocking, no audio-thread contention.

## Panic Mode (key: `p`)

### What it does
When activated, panic mode applies an immediate dramatic intensity override:
- Crossfades to the TENSE stem over 0.5 s (fast, cut-like)
- Sets `playbackRate` to **1.30** (~125 BPM from the 96 BPM bed) — chosen
  as a clearly audible dramatic acceleration without pitching so far out of
  key that the bed sounds wrong (~3 semitones sharp at this rate)
- Opens the brightness filter to maximum (8000 Hz)
- Sets tremolo to 7.5 Hz (near-maximum flutter)

When released, panic mode:
- Crossfades back to the classifier's current mood stem over 1.5 s (gentler)
- Applies the opposite-mood inversion if active (`oppositeMood` flag respected)
- Does NOT immediately reset filter/tremolo — the next incoming pencil message
  restores filter/tremolo, and the next biometric message restores the rate via
  the normal `bpmToPlaybackRate()` path. This gives a natural, gradual return.

### Interaction with Epic 9 classification
The `MoodClassifier` continues running normally during panic. It advances through
mood states and records them in the session tracker. But `crossfadeTo()` calls
from the classifier are suppressed (`if (!liveState.panicMode)`) so the panic
stem hold is not overridden by normal classification. When panic releases, we
crossfade to `classifier.currentMood` — the actual current classification state.

### Interaction with Epic 8.5 toggles
**Static mode:** panic mode fires even when static mode is on. Rationale: panic
is an intentional performer action (a deliberate "big moment"), not live biometric
noise. Static mode is meant to freeze unintended changes; an explicit 'p' keypress
is always intentional. The two can coexist — panic provides the intensity spike
while static prevents the baseline BPM from creeping between presses.

**Opposite-mood toggle:** on panic release, the stem that resumes is
`MOOD_INVERSE[classifier.currentMood]` when `oppositeMood` is true, so opposite
mood inversion is preserved correctly.

### Safety
Both features are skippable — the core demo works identically if 'p' and 'r'
are never pressed. If panic mode misbehaves (e.g. gets stuck), pressing 'p'
again always releases it.

## Key decisions
- **Portrait generation is fire-and-forget** — no await, no blocking. A slow or
  failing API call cannot affect live audio.
- **Panic crossfade is 0.5 s** — short enough to feel dramatic and instantaneous,
  not long enough to blur the "big moment" effect.
- **Rate on panic (1.30) is hardcoded** — not driven by the current BPM. This
  gives a predictable, rehearsable dramatic moment. The performer knows exactly
  what they'll hear.
- **Filter/tremolo not reset on panic release** — natural return via the next
  live messages feels more organic than a jarring snap to defaults.

## Known limitations
- **FAL_KEY required for real portrait generation.** Without it, the fallback
  SVG is always shown.
- **Portrait uses session data up to the moment 'r' is pressed**, not at end
  of performance. If pressed early, it reflects a partial session.
- **Panic mode playbackRate (1.30) is fixed** regardless of which mood stem is
  active. At the CALM stem's baseline, this is a larger perceived speed-up than
  at TENSE. Acceptable for a demo — the contrast is the point.
- **If the performer presses 'p' while in STATIC mode**, panic fires normally
  but the static mode guard means the next biometric message won't restore the
  rate after panic releases. The operator should release static mode ('s') after
  releasing panic ('p') if they want live rate control to resume.
