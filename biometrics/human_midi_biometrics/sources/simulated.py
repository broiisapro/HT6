from __future__ import annotations

import math
import time
from typing import Optional

from human_midi_biometrics.biometric_source import BiometricSource


class SimulatedBpmSource(BiometricSource):
    def __init__(self, base_bpm: float = 72.0, variation_bpm: float = 6.0) -> None:
        self.base_bpm = base_bpm
        self.variation_bpm = variation_bpm
        self._running = False
        self._start_time = 0.0

    async def start(self) -> None:
        self._running = True
        self._start_time = time.time()

    async def stop(self) -> None:
        self._running = False

    def get_bpm(self) -> Optional[float]:
        if not self._running:
            return None
        elapsed = time.time() - self._start_time
        bpm = self.base_bpm + math.sin(elapsed / 3.0) * self.variation_bpm
        return max(40.0, min(180.0, bpm))
