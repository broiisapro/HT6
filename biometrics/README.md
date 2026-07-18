# biometrics/ — Person A

WebSocket **client** for `biometric` messages (see `../contracts/README.md`).

## Setup

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

## Run

Mock mode (no server required):

```bash
.venv/bin/python run.py --source phone-camera --mock
```

Send over WebSocket:

```bash
.venv/bin/python run.py --source phone-camera --websocket-url ws://127.0.0.1:8765
```

Source options:
- `phone-camera`: OpenCV red-channel rolling peak detector.
- `polar-ble`: direct BLE Heart Rate Service (`0x180D`) via `bleak`.
- `polar-phone-relay`: local HTTP relay for BLE-via-phone-app data.
- `presage-cli`: Presage Technologies SmartSpectra webcam vitals SDK, bridged
  in via subprocess (laptop webcam) since no Python SDK exists.
- `presage-phone-relay`: local HTTP relay (`--presage-relay-port`, default
  8767) for an iPhone running Presage's SmartSpectra example app, mirroring
  `polar-phone-relay`'s approach.
- `simulated`: deterministic source for local transport testing.

Both Presage sources are the only ones that populate the contract's optional
`stress` field (0.0-1.0, derived from SmartSpectra's real HRV RMSSD metric —
`metrics.cardio.hrv.rmssd` in their Swift SDK — inverted since lower RMSSD
means more stressed) — see `../docs/presage-biometric-source.md` for setup,
the open items (API key, exact CLI/relay payload format, calibration of the
RMSSD normalization range), and how `stress` drives its own independent DSP
layer in `audio-engine/` (distinct from bpm-driven tempo and pencil-driven
melody).

Local logging test server:

```bash
.venv/bin/python human_midi_biometrics/mock_server.py
```
