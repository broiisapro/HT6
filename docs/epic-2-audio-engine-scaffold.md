# Epic 2 — Audio Engine Scaffold + fal.ai Bed

## Goal

Stand up the audio engine's WebSocket server per the Epic 0 contract and get a
pre-generated fal.ai instrumental bed looping audibly — the foundation Epics 3
(biometric → tempo) and 6 (pencil → melody) build on. No biometric- or
pencil-driven modulation yet; connections are accepted and messages are only
logged.

## How it works

```
audio-engine/
  src/
    index.js     — entry point: checks assets/bed.wav exists, starts server + playback
    server.js    — WebSocket server (contract), logs every message
    playback.js  — loads assets/bed.wav and loops it through system audio
  scripts/
    generate-bed.js — one-time fal.ai call, NOT run by the live server
  assets/
    bed.wav      — committed, pre-generated instrumental bed
```

- **Server** (`src/server.js`): a `ws` `WebSocketServer` listening on
  `0.0.0.0:8765` per `contracts/README.md`. On `connection`, it attaches a
  `message` listener that JSON-parses the payload and logs it — no branching
  on `type` yet. **Epic 3/6 hook point:** add an `if (message.type === "biometric")` /
  `"pencil"` branch inside that same listener and call into playback from
  there, instead of `console.log`.
- **Playback** (`src/playback.js`): reads `assets/bed.wav` from disk, decodes
  it, and loops it via `AudioBufferSourceNode.loop = true` through the
  system's real audio output. Returns `{ context, sourceNode }`.
  **Epic 3/6 hook point:** `context` already exposes the full native node set
  (`BiquadFilterNode`, `GainNode`, etc.); tempo can be driven via
  `sourceNode.playbackRate`, filter/timbre via inserting a `BiquadFilterNode`
  between `sourceNode` and `context.destination`. Build on these two objects
  rather than re-architecting playback.
- **Entry point** (`src/index.js`): fails fast with a clear message if
  `assets/bed.wav` is missing (i.e. `generate-bed` hasn't been run), otherwise
  starts the server and playback together. `npm start` runs this.
- **Bed generation** (`scripts/generate-bed.js`): a manual, one-time script
  (`npm run generate-bed`) — calls fal.ai, downloads the result, writes it to
  `assets/bed.wav`. Requires `FAL_KEY` in `audio-engine/.env` (see
  `.env.example`; `.env` itself is gitignored, never committed). The live
  engine never calls fal.ai — it only reads the committed file.

## Key decisions and why

**fal.ai model: `CassetteAI/music-generator`.** Investigated fal's current
catalog directly (not assumed from prior knowledge) — candidates considered
were `CassetteAI/music-generator`, `fal-ai/minimax-music`, and Sonilo's
text-to-music model. MiniMax Music is built around vocals/lyrics and reference
audio, and its 60s cap combined with a lyrics-first interface made it a worse
fit for an instrumental bed. CassetteAI takes a plain `{prompt, duration}`
input, generates fast, returns 44.1kHz stereo WAV, and its prompt format
explicitly supports specifying key and tempo in-line — useful for a bed that
needs to loop cleanly and sit under live tempo/filter control later. Prompt
used:

> "Warm, minimal instrumental loop bed for a live performance demo. Steady
> four-on-the-floor pulse, soft analog pads, gentle plucked synth arpeggio, no
> vocals, no drums fills or breaks, consistent energy throughout so it loops
> seamlessly. Key: A minor, Tempo: 96 BPM."

Duration: 60 seconds.

**Runtime: Node.js, plain Web Audio API via `node-web-audio-api` — not
Tone.js.** The original plan (per the roadmap doc) was Node + Tone.js. Tone.js
was actually installed and wired up first, but instantiating `new
Tone.Player(...)` against a `node-web-audio-api` `AudioContext` threw `param
must be an AudioParam`. Root cause: Tone.js's internal type checks
(`isAudioParam`/`isAudioNode` in `AdvancedTypeCheck.js`) delegate to the
`standardized-audio-context` package, which only recognizes *its own*
AudioParam/AudioNode classes as valid — not `node-web-audio-api`'s native
(Rust-backed) ones, even though both are spec-compliant. This is a real
interop gap between the two packages, not a config mistake. Rather than fight
it, playback was rewritten against `node-web-audio-api`'s native nodes
directly (`createBufferSource`, `.loop`, `.connect`) — still the Web Audio
API, just without the Tone.js abstraction layer. `node-web-audio-api` ships
prebuilt native binaries for Windows, macOS (x64 + arm64), and Linux, so this
works on every teammate's machine and the Mac used for the demo. Epics 3/6
should keep building on plain Web Audio nodes (`BiquadFilterNode`,
`playbackRate`, `GainNode`) rather than reintroducing Tone.js.

## WebSocket message-handling interface (current state)

`src/server.js`, inside `wss.on("connection", (socket, req) => { ... })`:

```js
socket.on("message", (raw) => {
  const message = JSON.parse(raw.toString());
  console.log(`[server] message from ${remote}:`, message);
  // Epic 3: if (message.type === "biometric") { ... drive tempo ... }
  // Epic 6: if (message.type === "pencil")   { ... drive melody/timbre ... }
});
```

Both message shapes match `contracts/README.md` exactly and were verified
against a real test client (`ws` client sending both `biometric` and `pencil`
payloads) — both logged correctly, connect/disconnect logged too.

## Verification performed

- `npm run generate-bed` — actually called fal.ai, downloaded a real 60s
  stereo 44.1kHz WAV (~10.5MB), saved to `audio-engine/assets/bed.wav`.
- `npm start` (`node src/index.js`) — server logs "listening on
  ws://0.0.0.0:8765", playback logs "looping ... (59.9s bed)", process runs
  without crashing (confirms `node-web-audio-api` found a real audio sink and
  is producing output rather than throwing `DeviceNotAvailable`).
- A throwaway `ws` test client connected, sent one `biometric` and one
  `pencil` message per the contract shape, both appeared correctly in the
  server log, then disconnect was logged.
- Audible confirmation (a human actually listening to the loop) still needs a
  manual check on demo hardware — see Known limitations.

## Deviations from scope

- Tone.js dropped in favor of `node-web-audio-api`'s native nodes (see above)
  — a deviation from the roadmap's original "Tone.js/Web Audio" phrasing, but
  still squarely "Web Audio", and the roadmap itself left the runtime choice
  to this epic's judgment.

## Known limitations

- Loop boundary is a hard cut (`AudioBufferSourceNode.loop` restarts the
  buffer at sample 0) — the prompt asked the model for a bed that loops
  "seamlessly," but no crossfade/beat-matching was added at the loop point.
  If the seam is audible on the actual demo hardware, add a short crossfade
  in `playback.js` before Epic 3/6 build further on top.
- This was built and tested on Windows (dev machine), not the Mac used for
  the actual demo — `node-web-audio-api` ships prebuilt macOS binaries so it
  should work unchanged, but flagging so whoever picks up Epic 3/6 does a
  quick `npm install` + `npm start` sanity check there first.
- Audible confirmation (a human actually listening to the loop, not just
  logs) hasn't been done yet — do that before relying on this for a demo.
- No reconnect/backpressure handling on the WebSocket server — fine for this
  epic's log-only scope, worth revisiting once Epic 3/6 add real-time control
  loops.
