from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Optional


@dataclass
class BiometricReading:
    bpm: float
    timestamp_ms: int


class BiometricSource(ABC):
    """Common interface for all live biometric data sources."""

    @abstractmethod
    async def start(self) -> None:
        """Prepare device resources and begin reading."""

    @abstractmethod
    async def stop(self) -> None:
        """Release resources."""

    @abstractmethod
    def get_bpm(self) -> Optional[float]:
        """Return latest smoothed bpm, or None if not available yet."""

    def get_stress(self) -> Optional[float]:
        """Return latest normalized stress index (0.0-1.0), or None if this
        source doesn't produce one. Most sources don't override this -- only
        ones that measure a genuinely separate signal (e.g. Presage's HRV
        derived stress index) do."""
        return None
