from __future__ import annotations

import asyncio
import logging
import os
import plistlib
import platform
import sys
import time
from dataclasses import dataclass
from typing import Optional

from human_midi_biometrics.biometric_source import BiometricSource
from human_midi_biometrics.smoothing import RollingBpmSmoother

HEART_RATE_SERVICE_UUID = "0000180d-0000-1000-8000-00805f9b34fb"
HEART_RATE_MEASUREMENT_CHAR_UUID = "00002a37-0000-1000-8000-00805f9b34fb"

logger = logging.getLogger(__name__)


@dataclass
class PolarBleConfig:
    device_name_hint: str = "Polar"
    scan_timeout_seconds: float = 12.0


class PolarBleSource(BiometricSource):
    def __init__(self, config: PolarBleConfig | None = None) -> None:
        self.config = config or PolarBleConfig()
        self._client: Optional[object] = None
        self._connected_device_name: Optional[str] = None
        self._latest_bpm: Optional[float] = None
        self._last_rx_ts: Optional[float] = None
        self._smoother = RollingBpmSmoother(window_size=5)
        self._running = False
        self._disconnect_event = asyncio.Event()

    async def start(self) -> None:
        self._preflight_bluetooth_permissions()
        from bleak import BleakClient

        device = await self._find_device()
        if device is None:
            raise RuntimeError(
                "Could not find Polar BLE device. Ensure Bluetooth is enabled and "
                "the watch is nearby/in workout screen."
            )
        self._connected_device_name = device.name or device.address
        self._client = BleakClient(device)
        await self._client.connect()
        self._running = True
        self._disconnect_event.clear()
        await self._client.start_notify(
            HEART_RATE_MEASUREMENT_CHAR_UUID,
            self._handle_hr_measurement,
        )
        logger.info("Connected to %s", self._connected_device_name)

    async def stop(self) -> None:
        self._running = False
        if self._client:
            try:
                await self._client.stop_notify(HEART_RATE_MEASUREMENT_CHAR_UUID)
            except Exception:
                pass
            await self._client.disconnect()
            self._client = None
        self._disconnect_event.set()

    def get_bpm(self) -> Optional[float]:
        if self._last_rx_ts is None:
            return None
        if time.time() - self._last_rx_ts > 5:
            return None
        return self._latest_bpm

    async def wait_until_disconnected(self) -> None:
        await self._disconnect_event.wait()

    async def _find_device(self):
        from bleak import BleakScanner

        devices = await BleakScanner.discover(timeout=self.config.scan_timeout_seconds)
        hint = self.config.device_name_hint.lower()
        for device in devices:
            name = (device.name or "").lower()
            if hint in name:
                return device
        return None

    def _handle_hr_measurement(self, _: int, data: bytearray) -> None:
        if not self._running:
            return

        if len(data) < 2:
            return
        flags = data[0]
        hr_16_bit = (flags & 0x01) != 0
        if hr_16_bit:
            if len(data) < 3:
                return
            bpm_raw = int.from_bytes(data[1:3], byteorder="little")
        else:
            bpm_raw = data[1]

        smoothed = self._smoother.add(float(bpm_raw))
        if smoothed is None:
            return
        self._latest_bpm = smoothed
        self._last_rx_ts = time.time()

    def _preflight_bluetooth_permissions(self) -> None:
        if platform.system() != "Darwin":
            return
        app_root = self._find_python_app_root(os.path.realpath(sys.executable))
        if not app_root:
            candidate = os.path.join(
                os.path.realpath(sys.base_prefix),
                "Resources",
                "Python.app",
                "Contents",
            )
            if os.path.exists(os.path.join(candidate, "Info.plist")):
                app_root = candidate
        if not app_root:
            return
        plist_path = os.path.join(app_root, "Info.plist")
        try:
            with open(plist_path, "rb") as f:
                plist = plistlib.load(f)
        except Exception:
            return
        if "NSBluetoothAlwaysUsageDescription" not in plist:
            raise RuntimeError(
                "Bluetooth scan blocked on macOS: Python.app Info.plist is missing "
                "NSBluetoothAlwaysUsageDescription. bleak scanning will SIGABRT under TCC."
            )

    @staticmethod
    def _find_python_app_root(executable_path: str) -> Optional[str]:
        marker = "/Contents/MacOS/"
        if marker in executable_path:
            return executable_path.split(marker)[0] + "/Contents"
        return None
