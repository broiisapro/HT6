# Human-MIDI

Biometrics + Apple Pencil → live audio, over a local WebSocket.

- Architecture: [`00-architecture.md`](00-architecture.md)
- Epic roadmap: [`01-epic-roadmap.md`](01-epic-roadmap.md)
- **Contract (read-only after Epic 0):** [`contracts/README.md`](contracts/README.md)

| Folder | Owner | Role |
|---|---|---|
| [`biometrics/`](biometrics/) | Person A | client → `biometric` messages (Epic 1) |
| [`audio-engine/`](audio-engine/) | Person B | WebSocket server `:8765` (Epic 2) |
| [`pencil-input/`](pencil-input/) | Person C | client → `pencil` messages (Epic 4) |
