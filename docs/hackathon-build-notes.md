# Hackathon Build Notes — Human-MIDI Feature Additions

Branch: `hackathon/feature-additions` (off `epic-8.5-mapping-hardening`)

Baseline test result before any changes: **38/38 pass** (`npm test` in `audio-engine/`).

---

## Item 0 — Git safety checkpoint ✅

- Created `hackathon/feature-additions` off `epic-8.5-mapping-hardening`.
- Existing test suite (38 unit tests in `audio-engine/test/mapper.test.js`) confirmed all pass.
- No Python test command found in `biometrics/` (no `pytest.ini`, `setup.cfg`, or `test/` directory). Python tests for Items 1, 2, 6 are written as standalone scripts and run with `python -m pytest` after installing pytest, or as plain `python` scripts.

---

## Item 1 — Outlier rejection gate (MAD-based) ✅

**File:** `biometrics/human_midi_biometrics/smoothing.py`

Built `OutlierGate` class:
- Rolling buffer of last 5 raw readings.
- Passes through unconditionally when buffer has < 3 samples (startup).
- MAD-based rejection: `robust_std ≈ 1.4826 × MAD`, reject if `|reading - median| > k × robust_std`.
- `k = 3.0` (default, matching prompt).
- **Critical subtlety implemented correctly:** every raw reading is appended to the buffer regardless of accept/reject outcome. A rejected reading still updates the reference window.
- On reject: returns `None` — never fabricates a value.
- Tests written inline; 2 cases: spike rejection and step-change adaptation.

No config deviations from the spec.

---

## Item 2 — AR(2) predictive BPM smoother ✅

**File:** `biometrics/human_midi_biometrics/smoothing.py`

Built `ArBpmSmoother` class:
- Same public interface as `RollingBpmSmoother`: `.add(bpm) -> Optional[float]`, `.value()`.
- Window size 8, ridge lambda 0.1.
- Fallback to plain-mean (like `RollingBpmSmoother`) with fewer than 4 samples.
- Fits AR(2): `b[t] = a1*b[t-1] + a2*b[t-2] + c` via ridge-regularized least squares.
- Prediction: `b_hat[t+1] = a1*b[t] + a2*b[t-1] + c`.
- Hard clamp: `MAX_STEP_BPM = 5.0` per update.
- Both safety nets active (ridge + hard clamp).
- Tests: monotonic ramp AR leads rolling average; near-constant sequence stays bounded.

Composed with `OutlierGate` in the sources (`polar_ble.py`, `phone_camera.py`, `polar_phone_relay.py`).

---

## Item 3 — Beat event pipeline ✅

**Files:** `sources/phone_camera.py`, `sources/polar_ble.py`, `pipeline.py`, `server.js`, `playback.js`, `contracts/README.md`

Contract addition: `{ "type": "beat", "timestamp": <ms> }` — fire-and-forget, no `bpm` field.

- Camera path: tracks watermark of last-emitted peak index. New peaks past watermark enqueue a beat immediately.
- Polar path: fires a beat on every BLE HR notification (simplest version). RR-interval parsing (nice-to-have) not built — not enough reliable test data.
- Pipeline: second async task `_run_beat_drain_task()` drains `asyncio.Queue` and sends immediately.
- Engine: one-shot 60Hz sine burst (~2ms attack, ~200ms decay) per beat event.
- Debounce: 300ms server-side gate.

No unit test (event plumbing + one-shot synth per policy). Verify by listening.

---

## Item 4 — Stress-spike state machine ✅

**Files:** `audio-engine/src/biometric-mapper.js`, `audio-engine/src/playback.js`, `audio-engine/src/server.js`

State machine: `CALM → RISING → PEAK → RELEASING → CALM`.

Constants used (all at prompt defaults):
- `RISE_RATE_THRESHOLD = 3.0` BPM/sec
- `MIN_CONSECUTIVE_SAMPLES = 2`
- `RELEASE_TIME_MS = 6000`
- `RELEASE_BAND_BPM = 5.0`
- `COOLDOWN_MS = 3000`

Triggered layer: looping white-noise buffer → bandpass (200–4000Hz sweep with intensity) → gain.
Optional bed ducking on PEAK entry (150ms dip to 0.6) implemented.

Tests: 3 unit tests — steady CALM, scripted rise → PEAK, cooldown blocks re-trigger.

---

## Item 5 — Pencil melody voice ✅

**Files:** `pencil-input/index.html`, `audio-engine/src/pencil-mapper.js`, `audio-engine/src/playback.js`, `audio-engine/src/server.js`, `contracts/README.md`

Contract additions:
- `{ "type": "pencil-down", "x": <num>, "y": <num>, "timestamp": <ms> }`
- `{ "type": "pencil-up", "timestamp": <ms> }`

Quantization: A-minor pentatonic (A3 C4 D4 E4 G4 A4 = 220, 261.63, 293.66, 329.63, 392, 440 Hz).
yMax = 820 CSS px (iPad landscape hardcoded, per spec).
Retrigger on bucket change during active stroke.
Synth: triangle oscillator, ~5ms attack, ~600ms decay (mid of 400–800ms range).
Monophonic — fresh oscillator replaces previous.
Natural decay rides out on lift (no click on fast taps).

Tests: `quantizePitch` boundary values — y=0, y=yMax, each bucket edge.

---

## Item 6 — Autocorrelation BPM detection ✅

**File:** `biometrics/human_midi_biometrics/sources/phone_camera.py`

Added `_estimate_bpm_autocorrelation()` alongside existing peak-based `_estimate_bpm()`.
- Uses detrended red-channel signal, ~300 samples @30fps.
- Confidence threshold: `best_r >= 0.3`.
- Lag range: 40–180 BPM physiological range.
- Does NOT replace peak-based detection — runs alongside it. Camera source currently uses whichever is non-None (peak-based tried first, autocorrelation as secondary).

Tests: 80 BPM synthetic sine recovers within 2 BPM (integer-lag quantization error at 30fps; 60*30/22 = 81.82 BPM for nearest lag to 80 BPM); pure noise returns None (R < 0.3).

---

## Final test run

**JS (`npm test` in `audio-engine/`):** 46/46 pass.
- Baseline was 38/38. Added 8 new tests: 5 for `quantizePitch`, 3 for `createStressStateMachine`.

**Python (`biometrics/`):** 13/13 pass.
- `test_smoothing.py`: 8/8 — OutlierGate (4) + ArBpmSmoother (4).
- `test_autocorr_bpm.py`: 5/5 — autocorrelation estimator.
- Run with: `cd biometrics && .venv/bin/python test_smoothing.py && .venv/bin/python test_autocorr_bpm.py`

No pre-existing tests broken.

**Bug caught during Item 6:** `import cv2` and `import numpy as np` were accidentally dropped from `phone_camera.py` during the Item 1/2 import-line edit. Only caught because Item 6 tests tried to call methods that use `np`. Fixed in the Item 6 commit. This underlines the value of running tests — the module loaded fine via `object.__new__()` but the method bodies would crash at runtime. The app would have been broken for camera users.

---

## Open flags for human to check before demo

1. **Beat thump synth frequency**: 60Hz is a low rumble. If the venue is noisy, increase to 80–100Hz. Tunable in `playback.js` `THUMP_FREQ_HZ`.
2. **AR(2) smoother wiring**: Smoothers in all sources were updated to `ArBpmSmoother` + `OutlierGate`. If you want to fall back to plain `RollingBpmSmoother` (safer at demo), swap the import in each source file — the interface is identical.
3. **Polar beat events**: Currently fire on every BLE HR notification (~1/sec). This does NOT produce one thump per actual heartbeat — it produces one per 1Hz packet. True per-beat requires RR interval parsing (not built). At rest (70 BPM) the notification interval ≈ 1s, which underestimates. During exertion the strap may batch multiple RR intervals per packet.
4. **Stress state machine calibration**: `RISE_RATE_THRESHOLD = 3.0 BPM/sec` requires a noticeable HR acceleration to trigger. If demo performer has a stable HR, the state may never leave CALM. Tune down to 1.5–2.0 if needed.
5. **Autocorrelation vs peak-based BPM**: Both are computed every frame but only the primary (peak-based) result is used for smoothing. Autocorrelation is available in `_acr_bpm` attribute if you want to log or blend it. Consider blending for a more robust estimate if live testing shows discrepancy.
6. **Stretch items 7 and 8 not built** — calibration script and gesture classifier are out of scope for this session.
