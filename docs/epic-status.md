# Human MIDI — Epic Status Tracker

Repo: `human-midi` (GitHub: `broiisapro/HT6`).
Last updated: 2026-07-18, after Epic 6 gap-closure pass.

## Epic completion status

| Epic | Status | Tag | Notes |
|---|---|---|---|
| 0 — Contract scaffolding | Complete | `epic-0-complete` | |
| 1 — Biometric source | Complete | `epic-1-complete` | |
| 2 — Audio engine scaffold | Complete | (folded into Epic 3 tag) | Tone.js abandoned; uses `node-web-audio-api` natively |
| 3 — Biometric→tempo mapping | Complete | `epic-3-complete` | `sourceNode.playbackRate` only; filter cutoff explicitly left unclaimed |
| 4 — Pencil capture | Complete | `epic-4-complete` | Confirmed `tilt` (altitudeAngle) is real/live on 10th-gen iPad + USB-C Pencil, never null except desktop mouse mock |
| 5 — Pencil networking | Complete | `epic-5-complete` | `pencil-input/index.html`, 30 msg/s throttle, `test-server.js` verification tool |
| 6 — Pencil→melody mapping | **Complete, one manual step outstanding** | `epic-6-complete` (on commit `862dfc4`) | See below |

## Epic 6 detail

**Implementation:** `audio-engine/src/pencil-mapper.js` maps `tilt` (falls back to smoothed `velocity` when null) → filter cutoff (300–8000 Hz, exponential), `velocity` → tremolo rate (0.5–8 Hz, note-density proxy, linear), `x` → stereo pan (-1..1, linear). Structurally separate AudioParams from Epic 3's `playbackRate` — verified no contention risk since Epic 3 never claimed filter cutoff.

**Verification passes so far:**
- Pass 1: synthetic script sanity check (all message types, malformed input, `tilt: null`).
- Pass 2: real Epic 1 biometric pipeline + synthetic pencil client, running concurrently — confirmed genuine interleaving via server logs.
- Pass 3 (gap closure): real Epic 1 biometric pipeline confirmed live again standalone; **browser/pencil-client half (`pencil-input/index.html` in an actual browser or mouse mock) was explicitly deferred** — deliberately skipped for now, to be tested manually and fixed if issues surface.
- Automated tests added: `audio-engine/test/mapper.test.js`, 19 tests, all passing (`npm test` from `audio-engine/`). Covers `bpmToPlaybackRate`, `pencilToAudioParams` (incl. `tilt: null` fallback), `createVelocitySmoother`.

**Outstanding before demo:** run `pencil-input/index.html` in a real browser (mouse mock is fine, real iPad+Pencil is better) against a live `audio-engine` + biometric pipeline, and confirm `[tempo]`/`[melody]` log lines interleave correctly. This is the one path never exercised end-to-end with real browser-originated events — everything else (mapping math, biometric integration, tag/doc hygiene) is verified.

**Minor discrepancy noted:** an earlier audit pass found no `epic-5-complete` tag on the remote; a later gap-closure session found it already present. Likely a teammate pushed it in between — not investigated further, low risk, but worth a `git tag -l` sanity check if it matters later.

**Tag note:** `epic-6-complete` sits on `862dfc4` (the PR merge commit), two commits behind current `main` (`bed9bfa`) which adds the gap-closure tests/docs. This is intentional — the tag marks "epic 6 implementation merged," not "latest housekeeping" — but flagging in case anyone expects the tag to track HEAD exactly.
