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

| Zone | Mood | Tracks |
|---|---|---|
| `calm/` | Calming, for a resting or anxious heart rate | 6 |
| `chill/` | Relaxed, feel-good, low-key positive | 3 |
| `happy/` | Upbeat, joyful | 3 |
| `hype/` | High-energy, gym/workout intensity | 4 |

Add more zone folders freely (e.g. `focus/`, `epic/`, `romantic/`) — nothing
in the code needs to change for a new one to be picked up.

## Current tracks

All CC0 1.0 (public domain dedication — no attribution legally required,
credited here anyway as good practice). License confirmed per-track by
checking each sound's Freesound page directly, not assumed from filename.

| File | Artist | Source |
|---|---|---|
| `calm/ambient-loop-yellowtree.mp3` | YellowTree | freesound.org/people/YellowTree/sounds/438901/ |
| `calm/621183__holizna__85-bpm-lofi-vibes-melody.wav` | holizna | freesound.org/s/621183/ |
| `calm/682461__muri_kuri__ukulele-loop.wav` | muri_kuri | freesound.org/s/682461/ |
| `calm/810704__cvltiv8r__uplift-piano-riff-82bpm-f.wav` | cvltiv8r | freesound.org/s/810704/ |
| `calm/810857__cvltiv8r__piano-ambience-chord-progression-82bpm-sharps-keys-not-quantized-natural.wav` | cvltiv8r | freesound.org/s/810857/ |
| `calm/852235__holizna__zambian-lo-fi-loop-cmaj-70-bpm.wav` | holizna | freesound.org/s/852235/ |
| `chill/680134__seth_makes_sounds__fuzzy-lofi-synth-song.wav` | seth_makes_sounds | freesound.org/s/680134/ |
| `chill/826622__xkeril__memories-of-a-sweet-summer-music-loop.wav` | xkeril | freesound.org/s/826622/ |
| `chill/841204__venus17__melancholic-game-loop-the-night-city.wav` | venus17 | freesound.org/s/841204/ |
| `happy/517675__danlucaz__80s-loop-6.wav` | danlucaz | freesound.org/s/517675/ |
| `happy/673525__seth_makes_sounds__lofi-loop-2023.wav` | seth_makes_sounds | freesound.org/s/673525/ |
| `happy/830500__shaunhillyard__a-ukulele-tune.wav` | shaunhillyard | freesound.org/s/830500/ |
| `hype/365187__furbyguy__chill-liquid-trap-loop.wav` | furbyguy | freesound.org/s/365187/ |
| `hype/514280__danlucaz__eletro-hit-4.wav` | danlucaz | freesound.org/s/514280/ |
| `hype/race-song-loop-neko4444.mp3` | neko_4444 | freesound.org/people/neko_4444/sounds/739064/ |
| `hype/upbeat124-badoink.mp3` | BaDoink | freesound.org/people/BaDoink/sounds/573986/ |

Add new rows here whenever a track is added, even under CC0 where
attribution isn't legally required — it keeps provenance traceable.
