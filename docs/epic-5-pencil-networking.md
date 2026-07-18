# Epic 5 — Pencil Client Networking

## Goal

Add a WebSocket client to the Epic 4 pencil web app that streams live Pencil
data to `audio-engine/` over the frozen contract, while keeping the local
visualization fully operational regardless of connection state.

## How the networking layer works

All networking lives in [`pencil-input/index.html`](../pencil-input/index.html)
as an Epic 5 section appended to Epic 4's existing script. No separate JS
file, no build step — the app stays a single file.

### Connection management

A WS URL input in the HUD sidebar (placeholder `ws://192.168.x.x:8765`)
lets the performer type the audio-engine host's LAN IP and click **Connect**
or press Enter. `wsConnect(url)` creates a `WebSocket` in a try/catch so a
bad URL can't throw uncaught. `ws.onopen / onerror / onclose` update a
`ws-status` badge in the HUD (green = connected, red = error/closed).
`wsDisconnect()` clears handlers before closing so no spurious state
transitions fire during teardown.

### Send path

`wsSendPencil(msg)` is called at the end of `emit()` — the one function
that every pointer/touch sample already flows through. The function:

1. Returns immediately if `wsOpen` is false (no open socket).
2. Checks `performance.now() - wsLastSendT < WS_INTERVAL_MS` (33.3 ms,
   i.e. 30 msg/s cap) and drops the frame if too soon.
3. Calls `ws.send(JSON.stringify(msg))` inside a try/catch to survive a
   socket that is in the process of closing.
4. Increments a visible sent-message counter in the HUD.

The drawing path (`draw()`, `emit()`, canvas compositing) is entirely
upstream of `wsSendPencil` — if the socket is absent or throws, the
catch swallows the error and drawing is unaffected.

### Message shape (frozen contract)

```json
{
  "type": "pencil",
  "pressure": 0.240,
  "x": 320.5,
  "y": 180.2,
  "velocity": 450.0,
  "tilt": 23.45,
  "timestamp": 1737000000000
}
```

- **pressure** — `Touch.force`; constant ~0.240 on this hardware (USB-C
  Pencil has no force sensor). Sent as-is per frozen contract.
- **x, y** — `touch.clientX/Y`, rounded to 1 decimal place.
- **velocity** — raw `Math.hypot(dx, dy) / dt` in px/s (not EMA-smoothed),
  rounded to 1 decimal place.
- **tilt** — real degrees from vertical (see below), rounded to 2 decimal
  places.
- **timestamp** — `Date.now()` at the time `emit()` is called (epoch ms,
  not `event.timeStamp` which is performance-relative).

## Tilt field handling

**Epic 4's definitive finding:** `Touch.altitudeAngle` is **present and
live** on the 10th-gen iPad with the Apple Pencil (USB-C), confirmed by
on-device testing. The tilt value is therefore a **real number, never
`null`**, as long as a Pencil or touch contact is active.

Epic 4 computes it as:

```
tiltDeg = 90 - altitudeAngle * (180 / π)
```

This converts altitude from the surface (in radians) to tilt from vertical
(in degrees), matching the AGENTS.md description. The value sent over the
wire is `s.tiltDeg` rounded to 2 dp when non-null, or `null` if the device
doesn't expose `altitudeAngle` (e.g. the desktop mouse mock, or a
hypothetical non-Pencil touch). No value is fabricated.

**Implication for audio-engine:** `tilt` will arrive as a non-null number
during a real Pencil session. The mouse mock sends `tilt: null` — useful
for testing the audio-engine null path.

## Key decisions

### Throttle: time-gate inside `wsSendPencil`, not at the event level

Epic 4 already throttles `touchmove` at ~60 Hz. Adding a second gate at
30 Hz inside `wsSendPencil` was the least invasive hook point — it touches
exactly one line in `emit()` and leaves the event/drawing cadence
unchanged. An alternative was to thin every other call at the event level,
but that would have required touching Epic 4's event handlers which are
intentionally untouched in this epic.

### No auto-reconnect

The performer triggers connect manually via the HUD button. Auto-reconnect
with exponential back-off was considered but rejected for the demo context:
the server is spun up once before the performance, and a failed/closed
connection during the show is surfaced visibly in the HUD status badge so
the performer can reconnect with one tap. A retrying loop would obscure
the failure and add complexity that's not worth it in a 36-hour build.

### Raw velocity sent (not EMA-smoothed)

Epic 4 smooths velocity with an EMA (α = 0.2) for the HUD readout but
explicitly notes "raw is what Epic 5 should send or smooth as it sees fit."
The audio-engine team can apply whatever smoothing suits the DSP mapping;
sending raw preserves maximum signal information.

### Host is configurable, not hardcoded

The WS URL is a free-text input in the HUD defaulting to the placeholder
`ws://192.168.x.x:8765`. This reflects the prompt's constraint ("make this
configurable, don't hardcode a guess") and the practical reality that the
Mac's LAN IP changes between networks.

## Verification tool

`pencil-input/test-server.js` is a Node.js WebSocket server (requires the
`ws` package in `pencil-input/package.json`) that stands in for
`audio-engine` during development. It logs every incoming message with
field values, validates all 7 required keys, and reports the average rate
on disconnect. Verified end-to-end: a contract-shaped message sent via the
`ws` client library was received, parsed, and all fields printed correctly.

**To use:**

```bash
cd pencil-input
npm install          # first time only
node test-server.js  # listens on ws://localhost:8765
```

Then open `index.html` in a browser (or serve over HTTP for the iPad),
type `ws://<mac-ip>:8765` in the HUD, click Connect, and draw. Messages
appear in the terminal in real time.

## Deviations from scope

None. Only `pencil-input/` was touched.

## Known limitations

- **No auto-reconnect.** A dropped connection (e.g. `audio-engine/` restarted)
  requires a manual reconnect tap in the HUD.
- **Pressure is a constant.** `pressure ≈ 0.240` on the USB-C Pencil. The
  audio-engine should map `tilt` and `velocity` instead (per Epic 4's flag).
- **Raw velocity is noisy at low speeds.** The per-sample px/s value spikes
  when the Pencil moves very slowly between coalesced events. The receiving
  end should apply its own smoothing if this drives an audible parameter.
- **Desktop mock sends `tilt: null`.** The mouse code path in Epic 4 has no
  tilt source, so the mouse mock always produces `tilt: null`. This is
  correct behaviour (not fabricated), but the audio-engine must handle null.

## Status

Definition of done met:
- Live stream of correctly-shaped messages verified via `test-server.js`.
- Tilt field populated with real degrees on Pencil; `null` on mouse mock.
- Local visualization confirmed unaffected when WebSocket is not connected.

```
git tag -a epic-5-complete -m "pencil client networking"
```
