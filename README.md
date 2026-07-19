# MusicFromDaHeart

Biometrics + Apple Pencil → live audio, over a local WebSocket.

- Architecture: [`00-architecture.md`](00-architecture.md)
- Epic roadmap: [`01-epic-roadmap.md`](01-epic-roadmap.md)
- **Contract (read-only after Epic 0):** [`contracts/README.md`](contracts/README.md)

| Folder | Owner | Role |
|---|---|---|
| [`biometrics/`](biometrics/) | Person A | client → `biometric` messages (Epic 1) |
| [`audio-engine/`](audio-engine/) | Person B | WebSocket server `:8765` (Epic 2) |
| [`pencil-input/`](pencil-input/) | Person C | client → `pencil` messages (Epic 4) |

## Get started

The full experience needs three pieces running: the audio engine (server + UI), a heart-rate source, and Apple Pencil input. However, the audio engine + UI alone is enough to hear it working with mock input.

### 1. Audio engine + UI

```bash
cd audio-engine
npm install
npm start
```

This starts the WebSocket server on `:8765` and the Vite UI together. Open the printed local URL (usually `http://localhost:5173`).

### 2. Heart-rate input (optional)

```bash
cd biometrics
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python run.py --source phone-camera --websocket-url ws://127.0.0.1:8765
```

No camera or Polar watch handy? Run it in mock mode instead:

```bash
.venv/bin/python run.py --source phone-camera --mock
```

### 3. Apple Pencil input (optional)

```bash
cd pencil-input
npm install
```

Open `index.html` on an iPad in Safari, pointed at the same WebSocket server, to send pencil pressure/velocity data.

---

Once all three are connected, pick a mode in the UI — static (pin a mood zone) or dynamic (let your heart rate drive it) — and the music responds live.
