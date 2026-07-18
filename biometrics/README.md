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
- `simulated`: deterministic source for local transport testing.

Local logging test server:

```bash
.venv/bin/python human_midi_biometrics/mock_server.py
```
