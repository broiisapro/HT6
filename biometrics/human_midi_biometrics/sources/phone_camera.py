from __future__ import annotations

import asyncio
import time
from collections import deque
from dataclasses import dataclass
from typing import Deque, Optional

import cv2
import numpy as np

from human_midi_biometrics.biometric_source import BiometricSource
from human_midi_biometrics.smoothing import RollingBpmSmoother


@dataclass
class PeakDetectionConfig:
    signal_window_seconds: float = 10.0
    minimum_peak_distance_seconds: float = 0.4
    min_amplitude_std_factor: float = 0.35


class PhoneCameraPpgSource(BiometricSource):
    def __init__(
        self,
        camera_index: int = 0,
        fps_target: float = 30.0,
        peak_config: PeakDetectionConfig | None = None,
    ) -> None:
        self.camera_index = camera_index
        self.fps_target = fps_target
        self.peak_config = peak_config or PeakDetectionConfig()

        self._capture: Optional[cv2.VideoCapture] = None
        self._task: Optional[asyncio.Task[None]] = None
        self._running = False

        self._timestamps: Deque[float] = deque()
        self._red_signal: Deque[float] = deque()
        self._smoothed_bpm: Optional[float] = None
        self._bpm_smoother = RollingBpmSmoother(window_size=6)

    async def start(self) -> None:
        self._capture = cv2.VideoCapture(self.camera_index)
        self._capture.set(cv2.CAP_PROP_FPS, self.fps_target)
        if not self._capture.isOpened():
            raise RuntimeError(
                f"Could not open camera index {self.camera_index}. "
                "Check camera permissions and camera index."
            )

        self._running = True
        self._task = asyncio.create_task(self._capture_loop())

    async def stop(self) -> None:
        self._running = False
        if self._task:
            await self._task
            self._task = None
        if self._capture:
            self._capture.release()
            self._capture = None

    def get_bpm(self) -> Optional[float]:
        return self._smoothed_bpm

    async def _capture_loop(self) -> None:
        assert self._capture is not None
        frame_delay = max(0.001, 1.0 / self.fps_target)

        while self._running:
            success, frame = self._capture.read()
            now = time.time()
            if not success:
                await asyncio.sleep(frame_delay)
                continue

            roi = self._extract_center_roi(frame)
            red_mean = float(np.mean(roi[:, :, 2]))

            self._timestamps.append(now)
            self._red_signal.append(red_mean)
            self._trim_window(now)

            bpm = self._estimate_bpm()
            if bpm is not None:
                smoothed = self._bpm_smoother.add(bpm)
                if smoothed is not None:
                    self._smoothed_bpm = smoothed

            await asyncio.sleep(frame_delay)

    def _trim_window(self, now: float) -> None:
        oldest_allowed = now - self.peak_config.signal_window_seconds
        while self._timestamps and self._timestamps[0] < oldest_allowed:
            self._timestamps.popleft()
            self._red_signal.popleft()

    def _estimate_bpm(self) -> Optional[float]:
        if len(self._red_signal) < 30:
            return None

        signal = np.array(self._red_signal, dtype=np.float64)
        timestamps = np.array(self._timestamps, dtype=np.float64)

        detrended = signal - np.mean(signal)
        std = float(np.std(detrended))
        if std <= 1e-6:
            return None

        min_peak_distance = self.peak_config.minimum_peak_distance_seconds
        min_height = std * self.peak_config.min_amplitude_std_factor

        candidate_indices = []
        last_peak_time = -1e9

        for i in range(1, len(detrended) - 1):
            if detrended[i] <= detrended[i - 1] or detrended[i] <= detrended[i + 1]:
                continue
            if detrended[i] < min_height:
                continue
            t = timestamps[i]
            if t - last_peak_time < min_peak_distance:
                continue
            candidate_indices.append(i)
            last_peak_time = t

        if len(candidate_indices) < 2:
            return None

        peak_times = timestamps[candidate_indices]
        intervals = np.diff(peak_times)
        if len(intervals) == 0:
            return None

        median_interval = float(np.median(intervals))
        if median_interval <= 0:
            return None

        bpm = 60.0 / median_interval
        if bpm < 40 or bpm > 180:
            return None
        return bpm

    @staticmethod
    def _extract_center_roi(frame: np.ndarray) -> np.ndarray:
        height, width = frame.shape[:2]
        box_h = max(20, height // 4)
        box_w = max(20, width // 4)
        y1 = height // 2 - box_h // 2
        y2 = y1 + box_h
        x1 = width // 2 - box_w // 2
        x2 = x1 + box_w
        return frame[y1:y2, x1:x2]
