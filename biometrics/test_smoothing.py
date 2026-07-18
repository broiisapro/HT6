"""
test_smoothing.py — lightweight unit tests for OutlierGate and ArBpmSmoother.

Run with:
    cd /Users/moksh/Code/HT6/biometrics
    python -m pytest test_smoothing.py -v
  or plain:
    python test_smoothing.py
"""

import sys
import os
sys.path.insert(0, os.path.dirname(__file__))

from human_midi_biometrics.smoothing import OutlierGate, ArBpmSmoother, RollingBpmSmoother


# ── OutlierGate ───────────────────────────────────────────────────────────────

def test_outlier_gate_spike_rejected():
    """Steady signal + one injected spike → spike is rejected (returns None)."""
    gate = OutlierGate()
    steady = [72.0, 73.0, 72.5, 71.0, 73.5]
    results = [gate.filter(v) for v in steady]
    # All startup / steady values should pass through
    assert all(r is not None for r in results), f"Steady values should all pass: {results}"

    # Now inject a spike
    spike_result = gate.filter(130.0)
    assert spike_result is None, f"Spike of 130 on steady ~72 BPM should be rejected, got {spike_result}"


def test_outlier_gate_step_change_adapts():
    """Genuine sustained BPM jump → gate adapts within a few samples, not rejected forever."""
    gate = OutlierGate()
    # Establish baseline at ~72 BPM
    for v in [72.0, 72.0, 72.0, 72.0, 72.0]:
        gate.filter(v)

    # Now genuine step to ~100 BPM — first one or two might be rejected, but
    # after a few the buffer shifts and the new level must pass.
    results = [gate.filter(100.0) for _ in range(6)]
    accepted = [r for r in results if r is not None]
    assert len(accepted) > 0, (
        f"Gate should adapt to genuine step change within 6 samples; got {results}"
    )


def test_outlier_gate_startup_pass_through():
    """With fewer than 3 samples in the buffer, all readings pass through."""
    gate = OutlierGate()
    assert gate.filter(72.0) == 72.0
    assert gate.filter(200.0) == 200.0  # wild value — still passes during startup


def test_outlier_gate_always_appends_on_reject():
    """Buffer updates even when a reading is rejected (the critical invariant)."""
    gate = OutlierGate()
    for v in [70.0, 70.0, 70.0, 70.0, 70.0]:
        gate.filter(v)

    # Reject a spike — buffer now contains the spike too
    gate.filter(200.0)

    # Feed more step-level values close to 200; the window has shifted toward it
    # so they should eventually start passing
    results = [gate.filter(195.0) for _ in range(8)]
    accepted = [r for r in results if r is not None]
    assert len(accepted) > 0, (
        "After buffer fills with post-spike values, nearby readings should be accepted"
    )


# ── ArBpmSmoother ─────────────────────────────────────────────────────────────

def test_ar_smoother_leads_rolling_average_on_ramp():
    """Monotonic ramp: AR predicted output should lead (be ahead of) rolling average."""
    ar = ArBpmSmoother(window_size=8)
    rolling = RollingBpmSmoother(window_size=8)

    ar_last = None
    roll_last = None
    for bpm in range(60, 90):  # 30-step monotonic ramp
        ar_last = ar.add(float(bpm))
        roll_last = rolling.add(float(bpm))

    assert ar_last is not None and roll_last is not None
    # AR should predict ahead of (higher than) a plain rolling mean on an upward ramp
    assert ar_last > roll_last, (
        f"AR ({ar_last:.2f}) should lead rolling avg ({roll_last:.2f}) on monotonic ramp"
    )


def test_ar_smoother_bounded_on_constant_signal():
    """Near-constant degenerate sequence: output must stay within MAX_STEP_BPM of input."""
    from human_midi_biometrics.smoothing import MAX_STEP_BPM
    ar = ArBpmSmoother()
    constant_bpm = 75.0
    last = None
    for _ in range(20):
        last = ar.add(constant_bpm)

    assert last is not None
    assert abs(last - constant_bpm) <= MAX_STEP_BPM + 0.01, (
        f"Near-constant input: output {last:.2f} too far from input {constant_bpm}"
    )


def test_ar_smoother_invalid_range_returns_none():
    """Values outside [40, 180] are rejected (same contract as RollingBpmSmoother)."""
    ar = ArBpmSmoother()
    assert ar.add(30.0) is None
    assert ar.add(200.0) is None


def test_ar_smoother_few_samples_fallback():
    """With fewer than 4 samples, uses plain mean (no crash)."""
    ar = ArBpmSmoother()
    r1 = ar.add(70.0)
    r2 = ar.add(72.0)
    r3 = ar.add(74.0)
    # All should be non-None and reasonable
    assert r1 is not None
    assert r2 is not None
    assert r3 is not None
    # With 3 samples, output ≈ plain mean = (70+72+74)/3 = 72
    assert abs(r3 - 72.0) < 1.0, f"Expected ~72 plain mean, got {r3}"


# ── Run as plain script ───────────────────────────────────────────────────────

if __name__ == "__main__":
    tests = [
        test_outlier_gate_spike_rejected,
        test_outlier_gate_step_change_adapts,
        test_outlier_gate_startup_pass_through,
        test_outlier_gate_always_appends_on_reject,
        test_ar_smoother_leads_rolling_average_on_ramp,
        test_ar_smoother_bounded_on_constant_signal,
        test_ar_smoother_invalid_range_returns_none,
        test_ar_smoother_few_samples_fallback,
    ]
    passed = 0
    failed = 0
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
