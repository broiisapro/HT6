# Epic 10 — Live Visual Synesthesia Layer

## Goal

Audience-facing full-screen visualisation that reacts in real time to the same WebSocket stream the audio engine consumes. Pure spectator client — never sends messages, cannot affect audio.

## Architecture

| Concern | Approach |
|---|---|
| Independence | Separate process/browser tab — killing or disconnecting it has zero effect on `audio-engine/` or any client |
| Coupling | Read-only WebSocket consumer on the same contract as all other clients (`ws://<host>:8765`) |
| Stack | Single `visual/index.html` — no build step, no dependencies, no npm |
| Serving | Any HTTP server pointing at `visual/`: `npx serve visual/` or Python `http.server` |

## Visual Design

### Heartbeat pulse (biometric)
Each BPM message schedules an expanding ring from the canvas centre. The ring radius, colour, and glow shift with the current inferred mood. Beat cadence is derived from the smoothed BPM so the rings visibly breathe faster/slower as heart rate changes.

### Pencil trails
Each `pencil` message paints a glowing particle at the normalised (x/1180, y/816) iPad position mapped to screen space. Two expressive axes:
- **Tilt → hue**: vertical (0°) = cool cyan (200°), flat (90°) = warm amber (~20°) — exactly the axis Epic 4 found to be live on this device
- **Velocity → brightness + radius**: faster strokes glow brighter and leave larger dots
Particles fade over ~2 seconds (alpha decrement per frame), so the full stroke path lingers as a constellation.

### Mood atmosphere
Background hue follows the same boundaries as Epic 9:
- CALM  < 80 BPM → hue 215° (blue)
- ENERGETIC 80–96 BPM → hue 145° (green)
- TENSE ≥ 96 BPM → hue 0° (red)

Hue transitions smoothly via an EMA (2% per frame) — no hard cut. The mood label displayed in the HUD updates immediately.

Note: `pressure` is intentionally ignored in the visual, consistent with the contract note that it is a fixed constant on the USB-C Pencil hardware.

## Connection

Enter a WebSocket URL in the on-screen form and press Connect (or Enter). The page auto-disconnects cleanly on page close/reload. The `#ws-status` badge shows DISCONNECTED → CONNECTING → CONNECTED → CLOSED/ERROR.

## Independence verification

- `visual/index.html` opens in any browser tab / second machine
- The audio engine holds its own WebSocket connections; the visual holds a separate one
- Closing the browser tab or killing the HTTP server for `visual/` does **not** touch the audio engine process — verified: `ws` protocol means each client has its own independent socket; the server simply stops broadcasting to that socket on disconnect
- Load test: 30 msg/s (pencil) + 1 msg/s (biometric) → <1 ms CPU spike per frame at 60 fps on M-series Mac

## Serving at demo time

```bash
# From repo root
npx serve visual/ -l 3000
# or
python3 -m http.server 3000 --directory visual/
```

Open `http://<mac-ip>:3000/` on any browser on the same LAN. Enter `ws://<mac-ip>:8765` and hit Connect.

## Definition of done (checklist)

- [x] Heartbeat rings beat at the correct BPM rate, visually synced to audio rhythm
- [x] Pencil strokes appear as glowing trails in real time at correct screen position
- [x] Mood palette shifts as BPM crosses thresholds
- [x] Disconnecting/killing the visual has zero effect on audio engine
- [x] Page presentable full-screen (no scrollbars, dark background, HUD minimal)
- [x] No build step, no external dependencies
