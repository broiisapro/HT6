# Epic 0 — Contract & Scaffolding (do this first, do it yourself)

This one's small enough that the Orchestrator (Cris) does it directly rather than handing it to a coding agent — it's structure and a shared doc, not real implementation.

## Repo structure to create

```
human-midi/
  biometrics/       Person A — owns this folder entirely
  audio-engine/      Person B — owns this folder entirely
  pencil-input/      Person C — owns this folder entirely
  contracts/         this file lives here — read-only for everyone after Epic 0
  docs/              one file per epic, docs/epic-N-slug.md
  README.md          links to docs/../00-architecture.md equivalent in this repo
```

## The contract (`contracts/README.md`)

`audio-engine/` hosts a WebSocket server at `ws://<mac-local-ip>:8765`. Both `biometrics/` and `pencil-input/` are clients that connect and send JSON messages — fire-and-forget, no response expected for MVP.

### Message shapes

```json
// Sent by biometrics/
{ "type": "biometric", "bpm": 72, "timestamp": 1737000000000 }

// Sent by pencil-input/
{ "type": "pencil", "pressure": 0.65, "x": 320.5, "y": 180.2, "velocity": 45.3, "tilt": null, "timestamp": 1737000000000 }
```

- `bpm`: smoothed beats-per-minute, plausible human range 40–180.
- `pressure`: 0.0–1.0, from the Pencil's `force` property.
- `x`, `y`: canvas coordinates.
- `velocity`: pixels/second, computed from position deltas over time.
- `tilt`: degrees if available on this iPad's WebKit version, otherwise `null` — never fabricate a value.
- `timestamp`: epoch milliseconds, client-side capture time.

### Rules everyone follows

1. **`audio-engine/` is the only folder that ever changes to handle a new message type or field.** If `biometrics/` or `pencil-input/` needs the contract to grow, that's a flagged change to this file, proposed and agreed before anyone codes against it — not a silent addition.
2. **Neither client folder ever imports from or edits `audio-engine/`,** and `audio-engine/` never edits the client folders. The WebSocket connection is the only coupling.
3. **Throttle client message rate** — max ~30 messages/sec even if the underlying signal updates faster (relevant to pencil-input especially, since touch events can fire much faster than that).
4. **Every client should have a local test/mock mode** that doesn't require a live server connection, so Epics 1, 2, and 4 can all be built and verified in parallel before any two of them are running at once.

## Definition of done for Epic 0

- Folder skeleton exists and is committed.
- This contract file is committed at `contracts/README.md`.
- Every teammate has pulled the repo and confirmed (verbally, in your group chat) they can see their own folder and have read the contract.
- Git tag: `git tag -a epic-0-complete -m "contract and scaffolding"`.

Once this is tagged, hand Epic 1, Epic 2, and Epic 4's prompts to Person A, B, and C respectively — all three can start at the same time.
