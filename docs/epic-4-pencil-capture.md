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

Full-screen canvas: each stroke's **thickness and color track tilt** (pen tilted
flatter = thicker + brighter), with **velocity** as the fallback expressive input
when tilt is absent (e.g. the desktop mouse mock). Tilt drives the visual instead
of pressure because pressure is hardware-dead on the USB-C Pencil (see finding
below). A live HUD shows pointerType, pressure, x, y, smoothed velocity, and tilt
in real time. "Clear canvas" button resets.

> **Flag for Epic 5 / audio-engine (Person B):** pressure was the intended
> melody/timbre control, but it is unavailable on this hardware. The live
> expressive axes on this iPad are **tilt** and **velocity**. Someone needs to
> decide which drives melody/timbre in the audio mapping. `pressure` will still
> be sent over the wire per the frozen contract, but it will be a constant —
> audio-engine should not map it. This does not change the contract; it's a
> mapping decision.

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

**On-device result (10th-gen iPad, Apple Pencil USB-C, tested):**

- **Tilt: AVAILABLE.** `Touch.altitudeAngle` / `Touch.azimuthAngle` are present and
  change live as the Pencil is tilted. Tilt is a usable expressive axis.
- **Pressure: NOT available — hardware limitation.** `Touch.force` (and the
  `PointerEvent.pressure` derived from it) is frozen at a constant `~0.240`
  regardless of how hard you press. Root cause: the **Apple Pencil (USB-C) has no
  force sensor** — it is the one Apple Pencil without pressure sensitivity, so the
  signal does not exist at the hardware level. No code change can recover it. A
  1st- or 2nd-gen Apple Pencil would be required for real pressure.

Desktop reference (Chromium, sanity only — **not** the device answer):
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

- **Pressure is dead on this hardware** (USB-C Pencil, no force sensor). The
  "press harder changes output" behavior is not achievable here; tilt/velocity
  are the substitutes. A pressure-capable Pencil (1st/2nd gen) would restore it
  with no code change.
- Raw velocity is noisy; HUD smooths it, raw is not. A later epic should decide
  the real smoothing for audio mapping.

## Status

Capture pipeline built and verified on the target iPad: events → extraction →
velocity → tilt → visualization all working. Tilt confirmed live; pressure
confirmed hardware-unavailable and documented. The original DoD's pressure check
is superseded by the hardware finding above; the visualization proves live
expressive response via tilt instead.

```
git tag -a epic-4-complete -m "pencil capture local"
```

(Tag once the team accepts the tilt/velocity substitution for the dead pressure
axis — see the flag under Visualization.)
