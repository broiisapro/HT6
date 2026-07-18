# Contract — Human-MIDI

Read-only for everyone after Epic 0. Only `audio-engine/` may ever grow this
contract, and only via a flagged, agreed change to this file (see Rule 1).

## Topology

`audio-engine/` hosts a WebSocket server at `ws://<mac-local-ip>:8765`.
Both `biometrics/` and `pencil-input/` are **clients** that connect and send
JSON messages — fire-and-forget, no response expected for MVP.

## Message shapes

```json
// Sent by biometrics/
{ "type": "biometric", "bpm": 72, "stress": null, "timestamp": 1737000000000 }
{ "type": "biometric", "bpm": 72, "stress": 0.42, "timestamp": 1737000000000 }

// Sent by pencil-input/
{ "type": "pencil", "pressure": 0.65, "x": 320.5, "y": 180.2, "velocity": 45.3, "tilt": null, "timestamp": 1737000000000 }
```

- `bpm`: smoothed beats-per-minute, plausible human range 40–180.
- `stress`: normalized 0.0 (calm) – 1.0 (tense) stress index, or `null` when
  the active biometric source doesn't produce one (phone-camera, Polar).
  Currently only the Presage SmartSpectra source populates this — see
  `docs/presage-biometric-source.md`. This is a genuinely separate signal from
  `bpm`, not derived from it: `bpm` drives tempo (Epic 3), `stress` drives a
  distinct DSP control (drive/tension) so the two don't fight over the same
  knob, the same way pencil's melody mapping (Epic 6) stays off tempo's knob.
- `pressure`: 0.0–1.0, from the Pencil's `force` property.
- `x`, `y`: canvas coordinates.
- `velocity`: pixels/second, computed from position deltas over time.
- `tilt`: degrees if available on this iPad's WebKit version, otherwise `null` — never fabricate a value.
- `timestamp`: epoch milliseconds, client-side capture time.

## Rules everyone follows

1. **`audio-engine/` is the only folder that ever changes to handle a new
   message type or field.** If `biometrics/` or `pencil-input/` needs the
   contract to grow, that's a flagged change to this file, proposed and agreed
   before anyone codes against it — not a silent addition.
2. **Neither client folder ever imports from or edits `audio-engine/`,** and
   `audio-engine/` never edits the client folders. The WebSocket connection is
   the only coupling.
3. **Throttle client message rate** — max ~30 messages/sec even if the
   underlying signal updates faster (relevant to pencil-input especially, since
   touch events can fire much faster than that).
4. **Every client should have a local test/mock mode** that doesn't require a
   live server connection, so Epics 1, 2, and 4 can all be built and verified in
   parallel before any two of them are running at once.
