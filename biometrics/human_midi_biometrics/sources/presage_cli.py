from __future__ import annotations

import asyncio
import logging
import re
import shlex
from collections import deque
from dataclasses import dataclass
from typing import Deque, Optional

from human_midi_biometrics.biometric_source import BiometricSource
from human_midi_biometrics.smoothing import RollingBpmSmoother

logger = logging.getLogger(__name__)


@dataclass
class PresageCliConfig:
    """Config for the Presage Technologies SmartSpectra vitals source, run as
    a local (laptop) CLI -- for a webcam plugged into the machine running
    biometrics/, not the iPhone path (see presage_phone_relay.py for that).

    SmartSpectra (contactless webcam heart rate/HRV/breathing rate) ships
    official SDKs for Kotlin, Swift, C++17, and Node/Electron only -- no
    Python bindings and no plain REST endpoint. Rather than guess at an
    undocumented API, this source runs whichever platform example app/CLI
    the developer has installed (per the SmartSpectra quickstart for their
    OS) as a subprocess and parses its stdout for a pulse-rate line. Point
    `command` at that installed example binary once you have an API key
    from the developer portal (physiology.presagetech.com) and have
    confirmed its exact output format -- see
    docs/presage-biometric-source.md for what was verified vs. left open.
    """

    command: str = "smartspectra-cli --continuous"
    bpm_pattern: str = r"(?:pulse|heart)[_ ]?rate[^0-9]{0,10}([\d.]+)"
    # SmartSpectra's actual SDK exposes HRV as RMSSD (metrics.cardio.hrv.rmssd
    # in the Swift SDK, milliseconds) -- confirmed from Presage's own iOS
    # quickstart sample code, NOT a pre-computed "stress index" as originally
    # assumed here. RMSSD is *inversely* related to stress/tension: LOWER
    # RMSSD means more stressed, HIGHER means calmer/more relaxed -- the
    # opposite direction of a typical "stress index". get_stress() below
    # inverts it accordingly. rmssd_min_ms/max_ms are an UNVERIFIED placeholder
    # typical adult resting range for normalizing it to the contract's
    # 0.0-1.0 `stress` field; recalibrate against real readings once an API
    # key is available (see docs/presage-biometric-source.md).
    hrv_pattern: str = r"(?:hrv|rmssd)[^0-9]{0,10}([\d.]+)"
    rmssd_min_ms: float = 15.0
    rmssd_max_ms: float = 100.0
    smoothing_window: int = 6


class PresageCliSource(BiometricSource):
    """Wraps a Presage SmartSpectra example app/CLI as a BiometricSource.

    Unlike phone-camera/Polar, this source also overrides get_stress(): it
    parses an HRV (RMSSD) line in addition to pulse rate and inverts/
    normalizes it into the contract's `stress` field, which drives its own
    DSP control in audio-engine (independent of bpm-driven tempo).
    """

    def __init__(self, config: Optional[PresageCliConfig] = None) -> None:
        self.config = config or PresageCliConfig()
        self._bpm_pattern = re.compile(self.config.bpm_pattern, re.IGNORECASE)
        self._hrv_pattern = re.compile(self.config.hrv_pattern, re.IGNORECASE)
        self._smoother = RollingBpmSmoother(window_size=self.config.smoothing_window)
        # RollingBpmSmoother hardcodes a 40-180 bpm-shaped range check, so it
        # can't be reused for RMSSD (different scale entirely) -- a plain
        # rolling mean over raw readings, normalized/inverted afterward.
        self._hrv_window: Deque[float] = deque(maxlen=self.config.smoothing_window)
        self._latest_bpm: Optional[float] = None
        self._latest_stress: Optional[float] = None
        self._process: Optional[asyncio.subprocess.Process] = None
        self._reader_task: Optional[asyncio.Task[None]] = None
        self._running = False

    async def start(self) -> None:
        self._running = True
        self._process = await asyncio.create_subprocess_exec(
            *shlex.split(self.config.command),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        self._reader_task = asyncio.create_task(self._read_loop())
        logger.info("Presage source started: %s", self.config.command)

    async def stop(self) -> None:
        self._running = False
        if self._reader_task:
            self._reader_task.cancel()
            self._reader_task = None
        if self._process and self._process.returncode is None:
            self._process.terminate()
            await self._process.wait()
        self._process = None

    def get_bpm(self) -> Optional[float]:
        return self._latest_bpm

    def get_stress(self) -> Optional[float]:
        return self._latest_stress

    async def _read_loop(self) -> None:
        assert self._process is not None and self._process.stdout is not None
        while self._running:
            line = await self._process.stdout.readline()
            if not line:
                break
            self._ingest_line(line.decode("utf-8", errors="ignore"))
        logger.warning("Presage subprocess stdout closed; no further bpm/stress updates.")

    def _ingest_line(self, line: str) -> None:
        bpm_match = self._bpm_pattern.search(line)
        if bpm_match:
            try:
                raw_bpm = float(bpm_match.group(1))
            except ValueError:
                raw_bpm = None
            if raw_bpm is not None:
                smoothed = self._smoother.add(raw_bpm)
                if smoothed is not None:
                    self._latest_bpm = smoothed

        hrv_match = self._hrv_pattern.search(line)
        if hrv_match:
            try:
                raw_rmssd = float(hrv_match.group(1))
            except ValueError:
                raw_rmssd = None
            if raw_rmssd is not None:
                self._hrv_window.append(raw_rmssd)
                mean_rmssd = sum(self._hrv_window) / len(self._hrv_window)
                span = self.config.rmssd_max_ms - self.config.rmssd_min_ms
                normalized = (mean_rmssd - self.config.rmssd_min_ms) / span if span else 0.0
                normalized = max(0.0, min(1.0, normalized))
                # Invert: low RMSSD (little beat-to-beat variability) = high
                # stress; high RMSSD (relaxed) = low stress.
                self._latest_stress = 1.0 - normalized
