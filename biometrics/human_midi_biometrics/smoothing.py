from __future__ import annotations

from collections import deque
from typing import Deque, Iterable, Optional

import numpy as np


class RollingBpmSmoother:
    def __init__(self, window_size: int = 8) -> None:
        self._window: Deque[float] = deque(maxlen=window_size)

    def add(self, bpm: float) -> Optional[float]:
        if bpm < 40 or bpm > 180:
            return None
        self._window.append(bpm)
        return self.value()

    def value(self) -> Optional[float]:
        if not self._window:
            return None
        return sum(self._window) / len(self._window)

    def values(self) -> Iterable[float]:
        return tuple(self._window)


# ── OutlierGate ──────────────────────────────────────────────────────────────

class OutlierGate:
    """MAD-based outlier gate that composes in front of a smoother.

    Every raw reading is appended to the rolling buffer regardless of whether
    it is accepted or rejected.  This is the critical correctness invariant:
    if only accepted readings updated the buffer, a genuine sustained BPM jump
    would be permanently rejected instead of eventually adapting.

    Usage::

        gate = OutlierGate()
        smoother = ArBpmSmoother()
        ...
        accepted = gate.filter(raw_bpm)
        if accepted is not None:
            result = smoother.add(accepted)
    """

    def __init__(self, buffer_size: int = 5, k: float = 3.0) -> None:
        """Args:
            buffer_size: rolling window of raw readings (default 5).
            k: rejection threshold multiplier on robust_std (default 3.0).
        """
        self._buffer: Deque[float] = deque(maxlen=buffer_size)
        self._k = k
        self._min_samples = 3  # pass through unconditionally during startup

    def filter(self, reading: float) -> Optional[float]:
        """Return *reading* if it passes the gate, else ``None``.

        The reading is always appended to the internal buffer first so the
        window adapts regardless of the accept/reject decision.
        """
        # Append BEFORE deciding — see class docstring.
        self._buffer.append(reading)

        if len(self._buffer) < self._min_samples:
            # Startup: not enough data to compute a meaningful median/MAD.
            return reading

        buf = np.array(self._buffer, dtype=np.float64)
        median = float(np.median(buf))
        mad = float(np.median(np.abs(buf - median)))
        robust_std = 1.4826 * mad

        # When robust_std is near zero (constant signal) any reading passes.
        if robust_std < 1e-9:
            return reading

        if abs(reading - median) > self._k * robust_std:
            return None  # rejected — do not forward to smoother

        return reading


# ── ArBpmSmoother ────────────────────────────────────────────────────────────

# Hard clamp: predicted BPM cannot jump more than this from the last output.
MAX_STEP_BPM: float = 5.0


class ArBpmSmoother:
    """AR(2) predictive BPM smoother with the same public interface as
    ``RollingBpmSmoother``.

    Drop-in replacement wherever a smoother is instantiated.  Fits
    ``b[t] = a1*b[t-1] + a2*b[t-2] + c`` via ridge-regularised least squares
    and outputs the one-step-ahead prediction ``b_hat[t+1]``.

    Two mandatory safety nets:
    1. Ridge regularisation (lambda=0.1) prevents blowup on near-singular fits.
    2. Hard clamp: predicted value cannot move more than ``MAX_STEP_BPM`` from
       the last emitted value per update.

    Falls back to plain-mean behaviour (like ``RollingBpmSmoother``) when
    the window has fewer than ``_min_fit_samples`` (4) readings.
    """

    def __init__(
        self,
        window_size: int = 8,
        ridge_lambda: float = 0.1,
        max_step_bpm: float = MAX_STEP_BPM,
    ) -> None:
        self._window: Deque[float] = deque(maxlen=window_size)
        self._ridge_lambda = ridge_lambda
        self._max_step = max_step_bpm
        self._min_fit_samples = 4
        self._last_value: Optional[float] = None

    def add(self, bpm: float) -> Optional[float]:
        """Ingest one BPM reading and return the smoothed/predicted value.

        Validates the range [40, 180] the same way ``RollingBpmSmoother`` does
        so they are interchangeable without extra guarding in callers.
        """
        if bpm < 40 or bpm > 180:
            return None

        self._window.append(bpm)
        result = self._predict()
        self._last_value = result
        return result

    def value(self) -> Optional[float]:
        return self._last_value

    def _predict(self) -> Optional[float]:
        window = list(self._window)
        n = len(window)

        if n < self._min_fit_samples:
            # Not enough data for a meaningful AR fit — use plain mean.
            return float(sum(window) / n)

        # Build design matrix X and target vector y for AR(2) + bias.
        # Row i: [b[i-2], b[i-1], 1]  →  predicts b[i]
        # We use all rows i in [2, n-1] (need two predecessors).
        rows = []
        targets = []
        for i in range(2, n):
            rows.append([window[i - 2], window[i - 1], 1.0])
            targets.append(window[i])

        X = np.array(rows, dtype=np.float64)       # shape (n-2, 3)
        y = np.array(targets, dtype=np.float64)    # shape (n-2,)

        # Ridge-regularised normal equations: (X^T X + λI) θ = X^T y
        # λI on the full 3×3 matrix (bias term included — keeps it simple and
        # avoids special-casing; the small λ barely affects the bias term).
        lam = self._ridge_lambda
        A = X.T @ X + lam * np.eye(3)
        b_rhs = X.T @ y
        try:
            theta = np.linalg.solve(A, b_rhs)  # [a2, a1, c]
        except np.linalg.LinAlgError:
            # Degenerate — fall back to mean.
            return float(sum(window) / n)

        a2, a1, c = float(theta[0]), float(theta[1]), float(theta[2])

        # One-step-ahead prediction using the two most recent values.
        b_hat = a1 * window[-1] + a2 * window[-2] + c

        # Hard clamp around the most recent raw observation (not last predicted),
        # keeping prediction grounded to physiological reality.
        last_raw = window[-1]
        b_hat = float(np.clip(b_hat, last_raw - self._max_step, last_raw + self._max_step))

        return b_hat
