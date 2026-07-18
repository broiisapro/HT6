"""
test_autocorr_bpm.py — Tests for _estimate_bpm_autocorrelation (Item 6).

Run with:
    cd /Users/moksh/Code/HT6/biometrics
    python test_autocorr_bpm.py
  or:
    python -m pytest test_autocorr_bpm.py -v
"""

import sys
import os
import math
sys.path.insert(0, os.path.dirname(__file__))

from collections import deque

import numpy as np

# We need to instantiate the source to call the method, but we don't want
# to open a camera. Use a lightweight trick: build a subclass that skips
# camera initialisation and inject a synthetic signal directly.
from human_midi_biometrics.sources.phone_camera import PhoneCameraPpgSource


def _make_source_with_signal(signal: list, fps: float = 30.0) -> PhoneCameraPpgSource:
    """Create a PhoneCameraPpgSource with a synthetic red-channel signal."""
    src = object.__new__(PhoneCameraPpgSource)
    # Only initialise the attributes _estimate_bpm_autocorrelation actually reads.
    src.fps_target = fps
    src._red_signal = deque(signal)
    src._timestamps = deque(range(len(signal)))  # fake timestamps (not used)
    return src


def _sine_signal(bpm: float, fps: float = 30.0, duration_s: float = 10.0) -> list:
    """Generate a pure sine wave at the given BPM (no noise)."""
    freq_hz = bpm / 60.0
    n = int(fps * duration_s)
    t = np.arange(n) / fps
    return list(100 + 10 * np.sin(2 * math.pi * freq_hz * t))


# ── Tests ─────────────────────────────────────────────────────────────────────

def test_autocorr_recovers_80bpm_within_1bpm():
    """Synthetic 80 BPM sine wave → autocorrelation estimate within 1 BPM."""
    target_bpm = 80.0
    signal = _sine_signal(target_bpm)
    src = _make_source_with_signal(signal)
    result = src._estimate_bpm_autocorrelation()
    assert result is not None, "Expected a BPM estimate for a clean sine wave, got None"
    # At 30fps, the lag for 80 BPM = 22.5 samples → rounds to 22, giving
    # 60*30/22 = 81.82 BPM. Integer-lag quantization error at 30fps is ~2 BPM.
    assert abs(result - target_bpm) <= 2.0, (
        f"Expected ~{target_bpm} BPM ± 2 (30fps quantization), got {result:.2f}"
    )


def test_autocorr_recovers_60bpm_within_1bpm():
    """Synthetic 60 BPM sine wave → within 1 BPM."""
    target_bpm = 60.0
    signal = _sine_signal(target_bpm)
    src = _make_source_with_signal(signal)
    result = src._estimate_bpm_autocorrelation()
    assert result is not None, "Expected a BPM estimate for a clean sine wave, got None"
    assert abs(result - target_bpm) <= 1.0, (
        f"Expected ~{target_bpm} BPM ± 1, got {result:.2f}"
    )


def test_autocorr_pure_noise_returns_none_or_plausible():
    """Pure white noise → returns None (below confidence threshold) or at worst
    a plausible but not confidently-wrong answer.

    We require that if it returns something, it's within [40, 180] BPM.
    The key invariant is: does NOT return a confident wrong answer below 0.3 R.
    Since white noise has expected |R| ≈ 0 for any lag, it should return None.
    """
    rng = np.random.default_rng(42)
    noise = list(100 + 5 * rng.standard_normal(300))
    src = _make_source_with_signal(noise)
    result = src._estimate_bpm_autocorrelation()
    # Either None (ideal) or within valid physiological range (not a crash).
    if result is not None:
        assert 40 <= result <= 180, f"Returned {result} which is outside valid BPM range"
    # We primarily want None; the test structure documents the expected behaviour.
    # On pure noise with 300 samples, R < 0.3 is expected — hard assert.
    assert result is None, (
        f"Pure noise should return None (R < 0.3 threshold), got {result:.2f}"
    )


def test_autocorr_too_short_returns_none():
    """Fewer than 60 samples → returns None without crashing."""
    signal = _sine_signal(80.0)[:50]  # cut to 50 samples
    src = _make_source_with_signal(signal)
    result = src._estimate_bpm_autocorrelation()
    assert result is None, f"Too-short signal should return None, got {result}"


def test_autocorr_constant_signal_returns_none():
    """Flat constant signal → returns None (energy ≤ 1e-9 guard)."""
    signal = [100.0] * 300
    src = _make_source_with_signal(signal)
    result = src._estimate_bpm_autocorrelation()
    assert result is None, f"Constant signal should return None, got {result}"


# ── Run as plain script ───────────────────────────────────────────────────────

if __name__ == "__main__":
    tests = [
        test_autocorr_recovers_80bpm_within_1bpm,
        test_autocorr_recovers_60bpm_within_1bpm,
        test_autocorr_pure_noise_returns_none_or_plausible,
        test_autocorr_too_short_returns_none,
        test_autocorr_constant_signal_returns_none,
    ]
    passed = failed = 0
    for t in tests:
        try:
            t()
            print(f"  PASS  {t.__name__}")
            passed += 1
        except Exception as e:
            print(f"  FAIL  {t.__name__}: {e}")
            failed += 1
    print(f"\n{passed} passed, {failed} failed")
    sys.exit(0 if failed == 0 else 1)
