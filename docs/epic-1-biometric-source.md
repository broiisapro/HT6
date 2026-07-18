# Epic 1: Biometric Source — Phone-Camera PPG + Polar Vantage M
## Goal
Deliver a live biometric BPM source for Human MIDI that can emit stable, real-world heart-rate-derived values through the shared `BiometricSource` interface into the websocket contract pipeline. This epic evaluated two real input paths (phone camera PPG and Polar Vantage M) and selected a demo recommendation based on observed hardware validation data.

## Implemented architecture (shared across sources)
- Common interface: `BiometricSource` with `start()`, `stop()`, `get_bpm()` in `biometrics/human_midi_biometrics/biometric_source.py`.
- Shared sender pipeline in `biometrics/human_midi_biometrics/pipeline.py`:
  - emits approximately 1 message/second
  - contract shape: `{"type":"biometric","bpm":...,"timestamp":...}`
  - supports websocket mode and local mock/log mode
  - clamps outgoing BPM to 40-180.
- Shared smoothing in `biometrics/human_midi_biometrics/smoothing.py` (`RollingBpmSmoother`) used by both real paths for consistent behavior.
- Sources implemented:
  - `sources/phone_camera.py`
  - `sources/polar_phone_relay.py`
  - `sources/simulated.py` (deterministic transport testing helper only).

## Phone-camera PPG path
## Signal-processing approach
Implemented in `biometrics/human_midi_biometrics/sources/phone_camera.py` using Python + OpenCV:
- Capture frames from selected camera index (`cv2.VideoCapture`), target ~30 FPS.
- Extract center ROI (quarter-frame region).
- Use red-channel mean intensity as raw PPG-like signal.
- Maintain rolling signal window and timestamps.
- Detrend by subtracting mean; compute standard deviation.
- Peak detection with explicit calibration constants:
  - signal window: `10.0s`
  - minimum peak distance: `0.4s`
  - minimum amplitude threshold: `0.35 * std`
- Estimate BPM from median peak interval (`60 / median_interval`), discard if outside 40-180 BPM.
- Smooth with `RollingBpmSmoother(window_size=6)`.

## Real validation results
Representative done-definition run (flash-on):
- Tooling: Camo Studio virtual camera (not Apple Continuity Camera), because Camo can force torch on.
- Conditions: phone torch forced on for full ~75s, finger on lens, deliberate breath-hold/movement perturbation around 45-55s.
- Observed BPM range: `52.93-118.63`.
- Behavior: early volatility, then tighter band around ~75-85 BPM; visible short-latency perturbation response.

Earlier non-flash baseline runs (Continuity Camera; torch unavailable/dropped):
- `45.82-132.96`
- `48.42-139.59`

Interpretation: flash-on Camo run was materially less noisy than non-flash baseline and is the valid representative camera result.

## Polar Vantage M integration attempts (in order)
## Step 1: Direct BLE from macOS via bleak — FAILURE
Attempted direct BLE HR service (`0x180D`) read from Mac with two runtimes:
- Homebrew Python 3.14 framework build
- isolated Python 3.12 venv

Fixes applied before retrying:
- added `NSBluetoothAlwaysUsageDescription` and `NSBluetoothPeripheralUsageDescription` to both relevant Info.plists
- re-signed app bundles
- restarted TCC daemon between attempts

Outcome:
- every attempt aborted with `SIGABRT` before any scan output
- persistent macOS TCC privacy-check crash despite plist/entitlement/re-sign interventions.

Conclusion: for this hardware/OS/toolchain combination, direct BLE path is a confirmed dead end for Epic 1.

## Step 2: Official Polar BLE SDK via iPhone relay — SUCCESS
Baseline sanity:
- unmodified iOS PSDC example app was confirmed working with real Polar Vantage M on iPhone.

Relay implementation:
- Separate repo used: `HT6/polar-ble-sdk` (fork of `github.com/polarofficial/polar-ble-sdk`, not merged into HT6).
- Relevant commit lineage in that repo: `ce77d03e`, `6c964fa8`, `b4547c0c`.
- iPhone app modified to POST each raw HR sample to Mac relay endpoint.
- Mac-side source implemented in HT6 commit `58652b7`:
  - file: `biometrics/human_midi_biometrics/sources/polar_phone_relay.py`
  - server: stdlib `ThreadingHTTPServer` on `/hr` (dependency-free choice)
  - smoothing: shared `RollingBpmSmoother(window_size=5)`
  - stale timeout handling and bounded raw buffer.

Real end-to-end validation:
- chain: real watch -> real phone HR broadcast -> HTTP POST -> Mac relay -> shared smoothing/clamping -> websocket contract
- 3-minute continuous real run:
  - `179` messages (~1/sec)
  - BPM range `77.0-97.6`
  - contract shape valid throughout: `{"type":"biometric","bpm":...,"timestamp":...}`
- ATS hardening pass:
  - initial debug state used broad `NSAllowsArbitraryLoads=true`
  - narrowed to:
    - `NSAllowsArbitraryLoadsInLocalNetworking=true`
    - `NSExceptionDomains` entry for `100.66.157.100` with insecure HTTP load exception
  - post-hardening real re-verification (45s) still successful:
    - BPM range `84.6-89.8`
    - valid contract messages.

Note: relay IP (`100.66.157.100`) is environment-specific and must be updated when Mac LAN IP changes.

## Demo recommendation (evidence-based)
Primary demo source: **Polar Vantage M via phone relay**.

Reasoning from observed data:
- Polar path produced tighter, more physiologically continuous output over a longer real run (`77.0-97.6` across 3 minutes, 179 messages, stable contract output).
- Camera path is workable but more setup-sensitive (finger placement, motion, lighting) and depends on third-party Camo for forced flash; even best run showed higher moment-to-moment variability (`52.93-118.63`) than Polar relay.

Fallback source: **phone-camera PPG via Camo flash-on** when watch path is unavailable.

## Key implementation decisions and calibration
- Language/runtime:
  - Python for Mac-side biometrics/pipeline for rapid iteration and consistency with existing HT6 stack.
  - Swift/iOS PSDC fork for watch-side ingestion and LAN relay because official Polar SDK path is supported/reliable.
- Relay server implementation:
  - stdlib `ThreadingHTTPServer` chosen over Flask/FastAPI to avoid introducing an extra runtime dependency for a narrow endpoint.
- Smoothing strategy:
  - single rolling-mean approach shared across real sources (`RollingBpmSmoother`) to normalize downstream behavior.
- Calibration constants:
  - camera signal window `10.0s`
  - min peak distance `0.4s`
  - min amplitude threshold `0.35 * std`
  - camera smoothing window `6`
  - polar relay smoothing window `5`
  - common BPM validity/clamp range `40-180`.

## BiometricSource integration notes for later epics
- Contract expected by downstream systems (including audio-engine side) is source-agnostic:
  - source must expose `start()`, `stop()`, `get_bpm()`
  - pipeline handles emission cadence and payload formatting.
- `get_bpm()` returns latest smoothed value or `None` if unavailable/stale.
- Because smoothing/clamp behavior is centralized/shared, future source additions should preserve this pattern for consistent downstream control response.

## Deviations from initial scope
- Added `SimulatedBpmSource` for deterministic transport/pipeline testing; not a replacement for real biometric paths.
- Switched camera validation tooling from Continuity Camera to Camo Studio specifically to guarantee torch control.

## Known limitations
- Phone-camera path:
  - sensitive to lighting, motion, finger placement
  - depends on Camo Studio for reliable flash control (Continuity Camera cannot force torch on).
- Polar phone-relay path:
  - requires phone and Mac on same reachable local network
  - requires custom Xcode-built app on phone (personal-team signing workflow; not App Store distribution)
  - ATS exception currently scoped to specific relay host/IP and must be updated when network/IP changes.
- Direct BLE from macOS:
  - not viable for this hardware/toolchain combination due to persistent pre-scan `SIGABRT` (TCC crash behavior).

## Epic 1 outcome
Epic 1 objective is met with two functioning real-source paths and a clear primary/fallback recommendation:
- Primary: Polar Vantage M via phone relay
- Fallback: phone-camera PPG via Camo flash-on
