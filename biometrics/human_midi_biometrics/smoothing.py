from __future__ import annotations

from collections import deque
from typing import Deque, Iterable, Optional


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
