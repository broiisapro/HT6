# assets/

Each subdirectory is a mood zone. Drop any `.mp3`/`.wav`/`.ogg` into an
existing zone folder to add it to that zone's random pool — no code change
needed. A new subdirectory becomes a new, selectable zone automatically (see
`../src/playback.js`). A zone with zero tracks is fine — the engine skips it
(with a warning) until it's filled; it just won't be selectable yet.

**Before adding a track, confirm it's actually licensed for this** — CC0,
CC-BY (note the required attribution here in this file), or another license
that permits redistribution/commercial use. Do not add tracks ripped from
streaming services (Spotify, Apple Music, etc.) — that's copyright
infringement regardless of context. See
`../../docs/epic-2-audio-engine-scaffold.md` for the reasoning.

## Current zones

| Zone | Mood | Status |
|---|---|---|
| `calm/` | Calming, for a resting or anxious heart rate | 1 seed track |
| `chill/` | Relaxed, feel-good, low-key positive | empty — awaiting sourcing |
| `happy/` | Upbeat, joyful | 1 seed track |
| `hype/` | High-energy, gym/workout intensity | 1 seed track |

Add more zone folders freely (e.g. `focus/`, `epic/`, `romantic/`) — nothing
in the code needs to change for a new one to be picked up.

## Current tracks

| File | License | Attribution |
|---|---|---|
| `calm/ambient-loop-yellowtree.mp3` | CC0 1.0 | "Ambient Loop" by YellowTree — freesound.org/people/YellowTree/sounds/438901/ |
| `happy/upbeat124-badoink.mp3` | CC0 1.0 | "Upbeat124.wav" by BaDoink — freesound.org/people/BaDoink/sounds/573986/ |
| `hype/race-song-loop-neko4444.mp3` | CC0 1.0 | "Race song loop" by neko_4444 — freesound.org/people/neko_4444/sounds/739064/ |

Add new rows here whenever a track is added, even under CC0 where
attribution isn't legally required — it keeps provenance traceable.
