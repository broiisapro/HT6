# Epic 2 — Audio Engine Scaffold + Instrumental Beds

## Goal

Stand up the audio engine's WebSocket server per the Epic 0 contract, play
pre-downloaded royalty-free instrumental beds across mood zones, and — since
this branch's scope grew past the original hand-off point — actually wire
live heart-rate and Pencil input into zone selection and melody/timbre, the
work originally slated for Epics 3 and 6.

**Status note:** Epics 3 and 6 were independently implemented and merged to
`main` while this branch was still in progress, built against the original
single-`bed.wav` design (see `01-epic-roadmap.md`). This branch's mood-zone
pivot diverged from that. Rather than leave two incompatible implementations
to reconcile later, the reusable logic from both (`pencil-mapper.js`
unchanged, the mapping *shape* of `biometric-mapper.js` adapted) was ported
in and wired up here directly — see "Key decisions" below. `main`'s versions
of `index.js`/`playback.js`/`server.js`/`biometric-mapper.js` are superseded
by this branch for `audio-engine/`; reconciling the two branches is still an
open step (not done as part of this work — see "Known limitations").

## How it works

```
audio-engine/
  src/
    index.js                  — entry point: warns on empty zone folders, fails only if ALL are empty, starts playback then server
    server.js                 — WebSocket server (contract); routes biometric -> zone/tempo, pencil -> melody/timbre
    playback.js               — auto-discovers assets/<zone>/ folders, crossfades between tracks/zones, persistent filter/pan/tremolo chain
    biometric-zone-mapper.js  — bpm -> zone (debounced) + continuous tempo nudge within a zone
    pencil-mapper.js          — pencil input -> filter cutoff / tremolo rate / pan (ported unchanged from main's Epic 6)
  scripts/
    fetch-beds.js — one-time download of the seed tracks, NOT run by the live server
  assets/
    calm/       — 6 tracks, calming/anxious-relief zone
    focused/    — 3 tracks, relaxed/feel-good zone (originally named "chill")
    dreamy/     — 3 tracks, upbeat/joyful zone (originally named "happy")
    energised/  — 4 tracks, gym/high-energy zone (originally named "hype")
```

Zones are **not hardcoded** — they're whatever subdirectories exist under
`assets/`. Drop more tracks into an existing zone's folder (any `.mp3`/`.wav`/
`.ogg`) and they join that zone's random pool with no code change; add a new
zone folder (e.g. `assets/epic/`) and it becomes selectable automatically.
This was a deliberate design response to a sequence of follow-up asks: first
"three (or four)" zones with tracks to be added later by hand, then a
broader ask for a richer mood taxonomy sourced by hand rather than by more
fal.ai/Freesound digging, then a rename pass (`chill`→`focused`,
`happy`→`dreamy`, `hype`→`energised`, `calm` unchanged) once real tracks were
in place and the final naming could be judged against actual content — the
zone count, names, and pool sizes aren't baked into the code anywhere. A zone
can also have **zero** tracks — the engine logs a warning and just skips it
as unselectable until it's filled, rather than failing startup, since zones
get added ahead of their tracks being sourced (this happened for real with
`focused/`, originally committed empty as `chill/` before tracks were
sourced for it).

- **Server** (`src/server.js`): a `ws` `WebSocketServer` listening on
  `0.0.0.0:8765` per `contracts/README.md`. On `message`, JSON-parses the
  payload, logs it, then:
  - `type: "biometric"` → `createZoneTracker()` (from
    `biometric-zone-mapper.js`) turns `bpm` into a debounced zone; if it
    differs from the last-applied zone, calls `playback.switchBed(zone)`.
    Every message also calls `playback.setTempo(rate)`, `rate` from
    `bpmToPlaybackRateWithinZone(bpm, zone)`. A stale timer (8000ms, same
    value main's Epic 3 used) reverts tempo to the neutral rate 1.0 if no
    biometric arrives — it does **not** revert the zone itself; snapping
    back to a default zone on a brief data gap would be a more jarring,
    less-motivated crossfade than just holding position.
  - `type: "pencil"` → smooths `velocity` (EMA, same alpha main's Epic 6
    used), calls `pencilToAudioParams()`, applies the result via
    `playback.setMelodyParams({cutoffHz, tremoloHz, pan})`. A separate,
    shorter stale timer (2000ms) reverts filter/tremolo/pan to their idle
    defaults via `playback.revertMelodyDefaults()`.
  All four handles (`switchBed`, `setTempo`, `setMelodyParams`,
  `revertMelodyDefaults`) come from `startPlayback()`'s return value, passed
  in as `startServer({ playback })`. If `playback` is omitted, messages are
  still logged but not applied — lets the server run standalone for testing.
- **Biometric zone mapping** (`src/biometric-zone-mapper.js`): `ZONE_BANDS`
  splits the original Epic 3 clamp range (50–130 BPM) into four 20-BPM bands,
  ordered by energy — `calm` (50–70) < `focused` (70–90) < `dreamy` (90–110)
  < `energised` (110–130). `classifyZone(bpm)` is a stateless lookup;
  `createZoneTracker()` wraps it with a `MIN_DWELL_MS` (4000ms) debounce so a
  bpm sitting on a band edge doesn't flip zones every message — a candidate
  zone has to persist for the full dwell window before it's actually
  committed. `bpmToPlaybackRateWithinZone(bpm, zone)` computes a continuous
  ±8% (`TEMPO_RANGE`) playbackRate nudge from bpm's position *within the
  given zone's band* — `zone` is passed explicitly (not re-derived from bpm)
  so that during the dwell window, while the committed zone hasn't caught up
  to a fast-moving bpm yet, the tempo nudge stays relative to whichever zone
  is actually still playing (saturating at the band edge) rather than
  leaking the target zone's math in early.
- **Playback** (`src/playback.js`): `listZones()`/`listTracks()`/
  `listPlayableZones()` as before. `startPlayback()` builds a **persistent**
  effects chain once — `filterNode` (lowpass) → `pannerNode` (stereo) →
  `tremoloGain` (LFO-modulated, note-density proxy) → `context.destination`
  — that survives every zone switch; `pencil-mapper.js`'s output targets
  these three nodes directly and never needs to know a switch happened.
  `switchBed(zone)` picks a random track from that zone, gives it its own
  gain node, ramps it in (0→1 over `CROSSFADE_SEC` = 0.6s) while ramping the
  outgoing track's gain out over the same window, then stops/disconnects the
  outgoing source once the fade completes — replacing the earlier hard
  stop/start cut. `setTempo(rate)` and `setMelodyParams(...)` apply to
  whichever source/chain is currently active without the caller needing to
  track node identity across switches. Returns
  `{ context, zone, switchBed, setTempo, setMelodyParams, revertMelodyDefaults }`
  — `zone` is the resolved starting zone, used by `server.js` to seed its
  zone tracker so the very first biometric message doesn't trigger a
  needless switch/crossfade if it lands in the zone already playing.
- **Pencil melody mapping** (`src/pencil-mapper.js`): ported unchanged from
  `main`'s Epic 6 — it's a pure function of pencil input (tilt → filter
  brightness, smoothed velocity → tremolo rate, x → pan) and doesn't know or
  care what's playing underneath, so it applies to the mood-zone chain
  as-is. See the file's own docstring for the full mapping rationale
  (exponential cutoff curve, why `pressure` isn't used — Epic 5 found it's a
  hardware constant on the demo iPad's USB-C Pencil — etc.).
- **Entry point** (`src/index.js`): discovers zones via `listZones()`/
  `listPlayableZones()`. Fails only if there are no zone folders at all, or
  every zone is empty; if some (but not all) zones have no tracks yet, logs a
  non-fatal warning listing which ones. Starts playback *before* the server
  (so the server has a real `playback` handle for the first message, not a
  race). `npm start` runs this.
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

The three seed tracks are from **Freesound.org**, licensed **CC0 1.0**
(public domain dedication — no attribution legally required; credited here
anyway as good practice). Verified by fetching each sound's page directly and
checking the license field, not assumed:

| Zone | Track | Artist | Duration | Source |
|---|---|---|---|---|
| calm | "Ambient Loop" | YellowTree | 35.2s | [freesound.org/.../438901](https://freesound.org/people/YellowTree/sounds/438901/) |
| dreamy | "Upbeat124.wav" | BaDoink | 46.5s | [freesound.org/.../573986](https://freesound.org/people/BaDoink/sounds/573986/) |
| energised | "Race song loop" | neko_4444 | 27.4s | [freesound.org/.../739064](https://freesound.org/people/neko_4444/sounds/739064/) |

Downloaded as Freesound's "hq" preview (128kbps MP3, 44.1kHz stereo) — full
originals require a Freesound account/OAuth to download; the preview quality
is sufficient for a demo bed and avoids adding an auth dependency to the
fetch script.

All four zones were later filled out with 13 more hand-sourced CC0 tracks
(see `assets/README.md` for the full attribution table) — every one checked
individually against its Freesound page before being added, same process as
the seed tracks above, not assumed from the filename.

**Multiple zones, a pool per zone, and a mood taxonomy rather than pure
heart-rate tiers.** Follow-up product decisions, in order: (1) instead of a
single bed with continuous DSP modulation, use distinct tracks selected by
zone; (2) each zone should hold multiple candidate tracks, randomly picked,
since more tracks were going to be sourced by hand afterward; (3) the zones
themselves should be moods, not just an intensity ladder — originally named
calm (calming an anxious/resting state), chill (relaxed, feel-good), happy
(upbeat, joyful), hype (gym/high-energy); (4) renamed to their current,
final names — `calm` (unchanged), `focused` (was `chill`), `dreamy` (was
`happy`), `energised` (was `hype`) — once real tracks existed in each folder
and the labels could be picked to fit the actual content rather than a
placeholder mood word. There's room for more zones (e.g. `epic`) since new
zone folders are auto-discovered. `focused` (then still named `chill`) was
created empty on purpose at first — no suitable CC0 track was sourced for it
yet; per decision (2)/(3), tracks for it (and any future zone) get added by
hand directly into `assets/<zone>/`, not through another automated
search/fetch pass — and it has since been filled in.

This epic originally stopped at the assets, the directory layout, and the
`switchBed` mechanism — deliberately not wiring zone selection to live bpm,
since that was Epic 3's job and the roadmap gated Epic 3 behind Epic 1 (a
real, tested BPM source). That gate turned out to already be satisfied:
Epic 1 finished (Polar Vantage M via phone relay, real hardware-validated)
before this branch caught up, and Epic 3/6 had *also* already been built and
merged to `main` — independently, against the old single-bed design. Given
that, wiring was done here rather than left as a second open branch to
reconcile: `biometric-zone-mapper.js`'s 20-BPM-band split (see above) is a
first-pass judgment call, not tuned against real Epic 1 data yet, and
"dreamy" vs. "focused" still don't obviously sit on a single bpm axis by mood
alone — flagging this as something to revisit once Epic 7 integration
actually runs a live performer against it.

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

`src/server.js`, inside `wss.on("connection", (socket, req) => { ... })` —
now live, not a hook-point comment:

```js
socket.on("message", (raw) => {
  const message = JSON.parse(raw.toString());
  console.log(`[server] message from ${remote}:`, message);

  if (message.type === "biometric") {
    const zone = trackZone(message.bpm); // debounced, biometric-zone-mapper.js
    const rate = bpmToPlaybackRateWithinZone(message.bpm, zone);
    if (zone !== currentZone) { currentZone = zone; playback.switchBed(zone); }
    playback.setTempo(rate);
  }

  if (message.type === "pencil") {
    const velocity = smoothVelocity(message.velocity);
    const params = pencilToAudioParams({ x: message.x, velocity, tilt: message.tilt });
    playback.setMelodyParams(params);
  }
});
```

Both message shapes match `contracts/README.md` exactly and were verified
against a mock test client (`ws` client sending both `biometric` and
`pencil` payloads, including a sustained bpm sequence to exercise the zone
debounce) — see "Verification performed" below.

## Verification performed

- `npm run fetch-beds` — actually downloaded all three seed tracks from
  Freesound, confirmed valid MP3 (128kbps, 44.1kHz, stereo) via `file`.
- A standalone decode test confirmed `node-web-audio-api`'s
  `decodeAudioData` handles MP3 (not just WAV) without issue.
- `npm start` (`node src/index.js`) with `chill/` (now `focused/`) empty —
  logged `[index] zone(s) with no tracks yet (not selectable until filled):
  chill` (non-fatal), then server logged "listening on ws://0.0.0.0:8765",
  playback logged `zone "calm": looping ambient-loop-yellowtree.mp3 (35.2s,
  picked from 1 track(s))`, process ran without crashing (confirms
  `node-web-audio-api` found a real audio sink and is producing output
  rather than throwing `DeviceNotAvailable`).
- After the rename and hand-sourced tracks landed: re-ran a decode check
  across all 4 zones / 16 tracks (`listZones()` + `listTracks()` +
  `decodeAudioData` on each file) — all decoded cleanly, no zone empty
  anymore.
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
  contract shape, appeared correctly in the server log, then disconnect was
  logged.
- **Reconciliation wiring** (biometric-zone-mapper.js + pencil-mapper.js +
  crossfade + persistent effects chain): exercised with a mock client
  sending a `pencil` message (tilt=70, velocity=900, x=1000) then a sustained
  `biometric` sequence (bpm=60, then bpm=125 repeated every 800ms). Confirmed:
  the zone held at `calm` through the ~4s dwell window even though
  `classifyZone(125)` would immediately say `energised`; the tempo rate
  during that window computed as `1.08` (top of `calm`'s own band, correctly
  saturated) rather than leaking `energised`'s band math in early; once the
  dwell elapsed, the zone committed to `energised` and the rate recomputed
  to `1.04` (bpm=125's actual position in `energised`'s band); the pencil
  message produced `cutoff=3857Hz tremolo=3.88Hz pan=0.69`; both stale-data
  timers fired and reverted correctly when messages stopped. This caught and
  fixed a real bug during testing — see "Deviations" below.

## Deviations from scope

- Music source switched from fal.ai (roadmap's original locked-in decision)
  to real, downloaded, CC0-licensed tracks — a product decision made after
  the fal.ai version was already working, not a technical necessity.
- Tone.js dropped in favor of `node-web-audio-api`'s native nodes (see above)
  — a deviation from the roadmap's original "Tone.js/Web Audio" phrasing, but
  still squarely "Web Audio", and the roadmap itself left the runtime choice
  to this epic's judgment.
- Multiple mood zones instead of one, each holding a pool of tracks rather
  than a single fixed file, and named for mood (calm/focused/dreamy/energised)
  rather than pure heart-rate tiers — a product decision anticipating Epic
  3's biometric-driven design and a desire for variety and emotional range,
  but this epic stops at asset prep + the `switchBed`/random-pick mechanism,
  not live switching logic (see above).
- Zone folders were renamed once, after they had real content: `chill` →
  `focused`, `happy` → `dreamy`, `hype` → `energised` (`calm` unchanged).
  Straight positional rename (kept each folder's already-sourced tracks in
  place, just relabeled the folder), not a re-sort by content — done via
  `git mv` so history/blame follows the files.
- `focused/` (then still named `chill/`) was committed empty at one point (a
  `.gitkeep` placeholder, no tracks) — intentional, awaiting hand-picked
  sourcing rather than another automated fetch. `index.js`/`playback.js`
  were both updated to tolerate this (warn, don't fail) since zone folders
  are expected to sometimes outpace their track sourcing. It's since been
  filled in along with the rename.
- Wired Epic 3/6-equivalent logic into this epic directly, rather than
  leaving it as separate epics to reconcile against `main`'s independent
  implementation later (see "Status note" at the top). `main`'s
  `biometric-mapper.js` (continuous playbackRate off one fixed, known-BPM
  bed) was **not** ported as-is — replaced by `biometric-zone-mapper.js`'s
  zone-plus-nudge design, since a pool of hand-sourced tracks with no
  consistent BPM metadata can't support a single global "speed up the
  track" formula the same way. `pencil-mapper.js` ported with no logic
  changes (bed-agnostic already). This means `main`'s versions of
  `index.js`/`playback.js`/`server.js`/`biometric-mapper.js` are superseded
  for `audio-engine/` by this branch's — merging the two branches will need
  to resolve that directly (take this branch's versions), not a line-level
  merge.
- Found and fixed a real bug during testing, not just a style note: the
  first draft of `bpmToPlaybackRateWithinZone(bpm)` re-derived its band from
  `classifyZone(bpm)` internally, so during the multi-second dwell window
  (zone still `calm` but bpm already in `energised`'s range) the tempo nudge
  would compute against the *target* zone's band instead of the zone
  actually still playing. Fixed by having the caller (`server.js`) pass the
  already-debounced `zone` explicitly into
  `bpmToPlaybackRateWithinZone(bpm, zone)`.

## Known limitations

- Zone switches now crossfade (600ms), but each track's own **loop point**
  is still a hard cut (`AudioBufferSourceNode.loop` restarts at sample 0).
  If that seam is audible on the demo hardware for a particular track, it's
  a per-track problem (some loop cleanly, some won't) rather than a
  systemic one.
- **This branch and `main` have diverged in `audio-engine/`** and haven't
  been reconciled — `main` has its own working `biometric-mapper.js` /
  `index.js` / `playback.js` / `server.js` built on the single-bed design
  (Epics 3 and 6, independently merged). Whoever merges this branch needs
  to take this branch's versions of those files wholesale, not attempt a
  line-level git merge — see "Deviations" above.
- **Not yet tested against real Epic 1/4/5 hardware** — only a mock `ws`
  client so far. Epic 1's actual bpm range/noise characteristics (Polar
  Vantage M via phone relay) and Epic 5's actual pencil message rate/jitter
  (10th-gen iPad + USB-C Pencil) haven't been run through
  `biometric-zone-mapper.js`'s dwell window or `pencil-mapper.js`'s
  smoothing yet. This is Epic 7's job (whole-team integration) — pulling
  `biometrics/`/`pencil-input/` onto this branch requires merging `main` in,
  which hasn't been done yet (deliberately deferred, not an oversight).
- The 20-BPM zone bands and `MIN_DWELL_MS`/`TEMPO_RANGE`/`CROSSFADE_SEC`
  constants in `biometric-zone-mapper.js`/`playback.js` are first-pass
  judgment calls, not tuned against a live performer — expect to retune
  once real data is available.
- This was built and tested on Windows (dev machine), not the Mac used for
  the actual demo — `node-web-audio-api` ships prebuilt macOS binaries so it
  should work unchanged, but flagging so whoever integrates next does a
  quick `npm install` + `npm start` sanity check there first.
- Freesound "hq" previews (128kbps MP3) are used, not the lossless originals
  — fine for a demo, but if audio quality becomes a concern, downloading the
  originals requires adding Freesound API auth to `fetch-beds.js`.
- No reconnect/backpressure handling on the WebSocket server — fine for a
  single-performer demo, worth revisiting if that assumption changes.
