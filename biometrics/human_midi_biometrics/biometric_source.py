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
