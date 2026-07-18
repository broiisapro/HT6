# Epic 4 — Pencil Capture (local only)

## Goal

Capture Apple Pencil input (pressure, position, velocity, and — if the hardware
exposes it — tilt) in web Safari on the iPad, and prove it live with a local
visualization. No networking; sending to `audio-engine/` is Epic 5.

## What it is

One self-contained file: [`pencil-input/index.html`](../pencil-input/index.html).
No build step, no dependencies. Open it in Safari on the iPad (serve the folder
over HTTP on the Mac and hit `http://<mac-ip>:PORT/` — `file://` is fine too but
some WebKit APIs behave better over HTTP).

## How capture works

- **Events:** Pointer Events (`pointerdown` / `pointermove` / `pointerup`). One
  code path covers the Apple Pencil (`pointerType === "pen"`), touch, and a
  desktop mouse — the mouse path is the built-in local mock so the page is fully
  testable with no iPad and no server (satisfies the contract's "local test mode"
  rule).
- **pressure:** `event.pressure` (0.0–1.0). For the Pencil this is real force;
  for a mouse it is ~0.5 while down, 0 on release (expected, not a bug).
- **x / y:** `event.clientX/Y`.
- **velocity:** `Math.hypot(dx, dy) / dt` where `dt` is the ms gap between
  consecutive samples converted to seconds → **pixels/second**. Divide-by-zero
  is guarded (returns 0). The HUD shows an EMA-smoothed value (`0.8` old / `0.2`
  new) because the raw per-sample number is jumpy; raw is what Epic 5 should send
  or smooth as it sees fit. Pure function `velocity()` at the top of the script
  has an inline `console.assert` self-check.
- **tilt:** derived from `altitudeAngle` when present (reported as degrees from
  vertical), else falls back to `tiltX`, else `null`. **Never fabricated** — if
  the device doesn't expose it, the field reads `null`.
- **Throttle:** move handling is capped at ~60 Hz; `getCoalescedEvents()` keeps
  the *drawn line* smooth without over-sampling the readout. Epic 5 must further
  cap outbound messages at ~30/s per the contract.

## Visualization

Full-screen canvas: each stroke's **thickness and color track pressure** (harder
= thicker + brighter). A live HUD on the right shows pointerType, pressure, x, y,
smoothed velocity, and tilt updating in real time. "Clear canvas" button resets.

## Tilt / altitude availability finding

**The definitive per-device answer must be read off the iPad**, because this is
exactly the thing that varies by WebKit version and can't be inferred from
desktop or generic Safari docs. The page answers it for you automatically: the
lower HUD block probes and labels **present / absent** for all four candidates on
first pen/touch contact —

- `PointerEvent.altitudeAngle`
- `PointerEvent.tiltX/tiltY`
- `Touch.altitudeAngle`
- `Touch.force`

**Record the on-device result here after the first real Pencil test:**

> _(fill in from the iPad — e.g. "10th-gen iPad, Safari 17.x: Touch.force
> present; Touch.altitudeAngle absent; PointerEvent.altitudeAngle present but
> always 0 → tilt effectively NOT usable." State it plainly whichever way it
> goes.)_

Desktop reference (Chromium, for sanity only — **not** the device answer):
`PointerEvent.altitudeAngle` present, `tiltX/Y` zero.

## Key decisions

- **Pointer Events over Touch Events** as the primary path: one handler for pen +
  touch + mouse, `pointerType` distinguishes them, and it gives a free desktop
  mock. Touch events are still probed *read-only* for tilt because they've
  historically been the more reliable Pencil-tilt source on iOS Safari.
- **Single HTML file, zero deps:** fastest thing to load on the iPad and to hand
  to Epic 5.

## Deviations from scope

None. No network code, nothing touched outside `pencil-input/` and this one docs
file.

## Known limitations

- Raw velocity is noisy; HUD smooths it, raw is not. A later epic should decide
  the real smoothing for audio mapping.
- Mouse pressure is not real pressure — desktop is for pipeline testing only; the
  pressure DoD ("press harder changes output") can only be confirmed with the
  Pencil on the iPad.
- Tilt finding above is pending the first on-device run.

## Status

Capture pipeline built and verified on desktop (events → extraction → velocity →
visualization all working). **Not yet tagged `epic-4-complete`** — the DoD
requires the on-iPad pressure and tilt confirmations above. Tag after the device
test:

```
git tag -a epic-4-complete -m "pencil capture local"
```
