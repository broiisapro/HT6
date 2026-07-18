# Epic 2 — Audio Engine Scaffold + Instrumental Beds

## Goal

Stand up the audio engine's WebSocket server per the Epic 0 contract and get
pre-downloaded, royalty-free instrumental beds looping audibly — the
foundation Epics 3 (biometric → tempo) and 6 (pencil → melody) build on. No
biometric- or pencil-driven modulation yet; connections are accepted and
messages are only logged.

## How it works

```
audio-engine/
  src/
    index.js     — entry point: warns on empty zone folders, fails only if ALL are empty, starts server + playback
    server.js    — WebSocket server (contract), logs every message
    playback.js  — auto-discovers assets/<zone>/ folders, randomly picks a track per zone, exposes switchBed()
  scripts/
    fetch-beds.js — one-time download of the seed tracks, NOT run by the live server
  assets/
    calm/ambient-loop-yellowtree.mp3   — committed seed track, calming/anxious-relief zone
    chill/                             — empty, awaiting hand-sourced tracks (relaxed/feel-good)
    happy/upbeat124-badoink.mp3        — committed seed track, upbeat/joyful zone
    hype/race-song-loop-neko4444.mp3   — committed seed track, gym/high-energy zone
```

Zones are **not hardcoded** — they're whatever subdirectories exist under
`assets/`. Drop more tracks into an existing zone's folder (any `.mp3`/`.wav`/
`.ogg`) and they join that zone's random pool with no code change; add a new
zone folder (e.g. `assets/focus/`) and it becomes selectable automatically.
This was a deliberate design response to two follow-up asks: first "three (or
four)" zones with tracks to be added later by hand, then a broader ask for a
richer mood taxonomy (calming/anxious-relief, chill/feel-good, hype/gym,
happy/upbeat, "etc.") sourced by hand rather than by more fal.ai/Freesound
digging — the zone count, names, and pool sizes aren't baked into the code
anywhere. A zone can also have **zero** tracks (like `chill/` right now) —
the engine logs a warning and just skips it as unselectable until it's
filled, rather than failing startup, since zones get added ahead of their
tracks being sourced.

- **Server** (`src/server.js`): a `ws` `WebSocketServer` listening on
  `0.0.0.0:8765` per `contracts/README.md`. On `connection`, it attaches a
  `message` listener that JSON-parses the payload and logs it — no branching
  on `type` yet. **Epic 3/6 hook point:** add an `if (message.type === "biometric")` /
  `"pencil"` branch inside that same listener and call into playback from
  there, instead of `console.log`.
- **Playback** (`src/playback.js`): `listZones()` reads `assets/`'s
  subdirectories; `switchBed(zone)` lists that zone's audio files, picks one
  at random, decodes it (cached by file path so repeat picks don't re-decode),
  stops whatever's currently looping, and starts the new track looping.
  Starts on `calm` if present, otherwise the first zone alphabetically.
  Returns `{ context, switchBed }`. **Epic 3 hook point:** map incoming
  `{type: "biometric", bpm}` to a zone name (from `listZones()`) — thresholds
  are Epic 3's call, not decided here — and call `switchBed(zone)` from the WS
  message handler. `context` also exposes the full native node set
  (`BiquadFilterNode`, `GainNode`, `playbackRate`, etc.) for finer continuous
  tempo/filter control on top of whichever track is playing, if Epic 3 wants
  smoother-than-a-hard-cut transitions between zones. **Epic 6 hook point:**
  same `context`, for melody/timbre DSP layered on top.
- **Entry point** (`src/index.js`): discovers zones via `listZones()`/
  `listPlayableZones()`. Fails only if there are no zone folders at all, or
  every zone is empty; if some (but not all) zones have no tracks yet, logs a
  non-fatal warning listing which ones and starts anyway. `npm start` runs
  this.
- **Bed download** (`scripts/fetch-beds.js`): a manual, one-time script
  (`npm run fetch-beds`) — downloads one seed CC0 track per zone from
  Freesound preview URLs into `assets/<zone>/<name>.mp3`. This only seeds the
  pool; add more tracks per zone by hand (no script needed — just drop files
  into the folder). The live engine never fetches at runtime — it only reads
  committed files. Re-run only if a committed seed file is lost.

## Key decisions and why

**Music source: real, downloaded, CC0-licensed tracks — not AI-generated.**
The original plan (and the roadmap's locked-in tech decision) was a
fal.ai-generated bed; that was built first and worked (see git history on
this branch for the fal.ai version). Partway through, the actual product
decision changed: use real royalty-free music instead of AI-generated audio.
Note this also sidesteps a real risk the fal.ai path didn't have to consider:
we explicitly avoided ripping/downloading copyrighted streaming-service audio
(e.g. Spotify) for licensing reasons, and confirmed each track below carries a
license that permits this use.

All three tracks are from **Freesound.org**, licensed **CC0 1.0** (public
domain dedication — no attribution legally required; credited here anyway as
good practice). Verified by fetching each sound's page directly and checking
the license field, not assumed:

| Zone | Track | Artist | Duration | Source |
|---|---|---|---|---|
| calm | "Ambient Loop" | YellowTree | 35.2s | [freesound.org/.../438901](https://freesound.org/people/YellowTree/sounds/438901/) |
| happy | "Upbeat124.wav" | BaDoink | 46.5s | [freesound.org/.../573986](https://freesound.org/people/BaDoink/sounds/573986/) |
| hype | "Race song loop" | neko_4444 | 27.4s | [freesound.org/.../739064](https://freesound.org/people/neko_4444/sounds/739064/) |

`chill` currently has no seed track — left empty deliberately, see the mood
taxonomy decision below.

Downloaded as Freesound's "hq" preview (128kbps MP3, 44.1kHz stereo) — full
originals require a Freesound account/OAuth to download; the preview quality
is sufficient for a demo bed and avoids adding an auth dependency to the
fetch script.

**Multiple zones, a pool per zone, and a mood taxonomy rather than pure
heart-rate tiers.** Follow-up product decisions, in order: (1) instead of a
single bed with continuous DSP modulation, use distinct tracks selected by
zone; (2) each zone should hold multiple candidate tracks, randomly picked,
since more tracks were going to be sourced by hand afterward; (3) the zones
themselves should be moods, not just an intensity ladder — calm (calming an
anxious/resting state), chill (relaxed, feel-good), happy (upbeat, joyful),
hype (gym/high-energy), with room for more (e.g. `focus`, `epic`) since new
zone folders are auto-discovered. `chill` was created empty on purpose — no
suitable CC0 track was sourced for it yet; per decision (2)/(3), tracks for
it (and any future zone) get added by hand directly into `assets/<zone>/`,
not through another automated search/fetch pass.

This epic prepares the assets, the directory layout, and the `switchBed`
mechanism only — deliberately **not** wiring zone selection to live bpm (or
any other signal) values, since picking a zone from a live signal is Epic 3's
job (biometric → tempo mapping) and the roadmap gates Epic 3 behind Epic 1 (a
real, tested BPM source) being done. Building that selection logic against
fake/mocked bpm now would risk tuning thresholds/mappings against data that
doesn't resemble what Epic 1's actual detector produces — and moods like
"happy" vs. "chill" don't obviously sit on a single bpm axis the way
calm→hype does, so how a live signal picks among more than three mood zones
is itself an open design question left to Epic 3, not decided here.

**Runtime: Node.js, plain Web Audio API via `node-web-audio-api` — not
Tone.js.** Tone.js was tried first (per the roadmap's original phrasing), but
instantiating `new Tone.Player(...)` against a `node-web-audio-api`
`AudioContext` threw `param must be an AudioParam`. Root cause: Tone.js's
internal type checks (`isAudioParam`/`isAudioNode` in
`AdvancedTypeCheck.js`) delegate to the `standardized-audio-context` package,
which only recognizes *its own* AudioParam/AudioNode classes as valid — not
`node-web-audio-api`'s native (Rust-backed) ones, even though both are
spec-compliant. This is a real interop gap between the two packages, not a
config mistake. Rather than fight it, playback was built against
`node-web-audio-api`'s native nodes directly (`createBufferSource`, `.loop`,
`.connect`) — still the Web Audio API, just without the Tone.js abstraction
layer. `node-web-audio-api` ships prebuilt native binaries for Windows,
macOS (x64 + arm64), and Linux, so this works on every teammate's machine and
the Mac used for the demo. Epics 3/6 should keep building on plain Web Audio
nodes (`BiquadFilterNode`, `playbackRate`, `GainNode`) rather than
reintroducing Tone.js.

## WebSocket message-handling interface (current state)

`src/server.js`, inside `wss.on("connection", (socket, req) => { ... })`:

```js
socket.on("message", (raw) => {
  const message = JSON.parse(raw.toString());
  console.log(`[server] message from ${remote}:`, message);
  // Epic 3: if (message.type === "biometric") { const zone = bpmToZone(message.bpm); switchBed(zone); }
  // Epic 6: if (message.type === "pencil")   { ... drive melody/timbre ... }
});
```

Both message shapes match `contracts/README.md` exactly and were verified
against a real test client (`ws` client sending both `biometric` and `pencil`
payloads) — both logged correctly, connect/disconnect logged too.

## Verification performed

- `npm run fetch-beds` — actually downloaded all three seed tracks from
  Freesound, confirmed valid MP3 (128kbps, 44.1kHz, stereo) via `file`.
- A standalone decode test confirmed `node-web-audio-api`'s
  `decodeAudioData` handles MP3 (not just WAV) without issue.
- `npm start` (`node src/index.js`) with `chill/` empty — logs
  `[index] zone(s) with no tracks yet (not selectable until filled): chill`
  (non-fatal), then server logs "listening on ws://0.0.0.0:8765", playback
  logs `zone "calm": looping ambient-loop-yellowtree.mp3 (35.2s, picked from
  1 track(s))`, process runs without crashing (confirms `node-web-audio-api`
  found a real audio sink and is producing output rather than throwing
  `DeviceNotAvailable`).
- Random-pick logic specifically verified: temporarily duplicated a track into
  `assets/calm/` (2 files), called `switchBed("calm")` five times in a row,
  confirmed the log showed both filenames appearing across calls (not stuck
  on one) — then removed the duplicate.
- **Audible confirmation**: a human listened to the running engine and
  confirmed real audio output for the single-fal.ai-bed and single-CC0-bed
  versions earlier in this epic. Confirm audibly again now that the layout
  is per-zone folders with random pick and a broader mood taxonomy — the loop
  mechanism is unchanged (same `AudioBufferSourceNode` path) but do a
  listen-through before relying on this for a demo, especially once more
  tracks are added per zone.
- A throwaway `ws` test client connected, sent a `biometric` message per the
  contract shape, appeared correctly in the server log (still just logged,
  not acted on), then disconnect was logged.

## Deviations from scope

- Music source switched from fal.ai (roadmap's original locked-in decision)
  to real, downloaded, CC0-licensed tracks — a product decision made after
  the fal.ai version was already working, not a technical necessity.
- Tone.js dropped in favor of `node-web-audio-api`'s native nodes (see above)
  — a deviation from the roadmap's original "Tone.js/Web Audio" phrasing, but
  still squarely "Web Audio", and the roadmap itself left the runtime choice
  to this epic's judgment.
- Multiple mood zones instead of one, each holding a pool of tracks rather
  than a single fixed file, and named for mood (calm/chill/happy/hype) rather
  than pure heart-rate tiers — a product decision anticipating Epic 3's
  biometric-driven design and a desire for variety and emotional range, but
  this epic stops at asset prep + the `switchBed`/random-pick mechanism, not
  live switching logic (see above).
- `chill/` is committed empty (a `.gitkeep` placeholder, no tracks) —
  intentional, awaiting hand-picked sourcing rather than another automated
  fetch. `index.js`/`playback.js` were both updated to tolerate this (warn,
  don't fail) since zone folders are now expected to sometimes outpace their
  track sourcing.

## Known limitations

- Zone switches (`switchBed`) are a hard cut — stop one `AudioBufferSourceNode`,
  start another. No crossfade between zones yet. Same is true of each track's
  own loop point. If either seam is audible on the demo hardware, add a short
  crossfade in `playback.js` before Epic 3/6 build further on top.
- This was built and tested on Windows (dev machine), not the Mac used for
  the actual demo — `node-web-audio-api` ships prebuilt macOS binaries so it
  should work unchanged, but flagging so whoever picks up Epic 3/6 does a
  quick `npm install` + `npm start` sanity check there first.
- Freesound "hq" previews (128kbps MP3) are used, not the lossless originals
  — fine for a demo, but if audio quality becomes a concern, downloading the
  originals requires adding Freesound API auth to `fetch-beds.js`.
- No reconnect/backpressure handling on the WebSocket server — fine for this
  epic's log-only scope, worth revisiting once Epic 3/6 add real-time control
  loops.
