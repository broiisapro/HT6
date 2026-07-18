from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass
from typing import Optional

import websockets

from human_midi_biometrics.biometric_source import BiometricSource

logger = logging.getLogger(__name__)


@dataclass
class PipelineConfig:
    websocket_url: str = "ws://127.0.0.1:8765"
    send_interval_seconds: float = 1.0
    mock_mode: bool = False


class BiometricPipeline:
    def __init__(self, source: BiometricSource, config: PipelineConfig) -> None:
        self.source = source
        self.config = config

    async def run(self) -> None:
        await self.source.start()
        try:
            if self.config.mock_mode:
                await self._run_mock_loop()
            else:
                await self._run_websocket_loop()
        finally:
            await self.source.stop()

    async def _run_mock_loop(self) -> None:
        while True:
            payload = self._next_payload()
            if payload:
                print(
                    f"[MOCK] bpm={payload['bpm']:.1f} "
                    f"timestamp={payload['timestamp']}"
                )
            await asyncio.sleep(self.config.send_interval_seconds)

    async def _run_websocket_loop(self) -> None:
        while True:
            try:
                async with websockets.connect(self.config.websocket_url) as ws:
                    logger.info("Connected to websocket server: %s", self.config.websocket_url)
                    while True:
                        payload = self._next_payload()
                        if payload:
                            await ws.send(json.dumps(payload))
                            print(
                                f"[WS] sent bpm={payload['bpm']:.1f} "
                                f"timestamp={payload['timestamp']}"
                            )
                        await asyncio.sleep(self.config.send_interval_seconds)
            except Exception as exc:
                logger.warning("WebSocket connection failed (%s). Retrying in 2s.", exc)
                await asyncio.sleep(2)

    def _next_payload(self) -> Optional[dict]:
        bpm = self.source.get_bpm()
        if bpm is None:
            return None
        bpm = float(max(40.0, min(180.0, bpm)))

        stress = self.source.get_stress()
        if stress is not None:
            stress = float(max(0.0, min(1.0, stress)))

        return {
            "type": "biometric",
            "bpm": round(bpm, 2),
            "stress": round(stress, 3) if stress is not None else None,
            "timestamp": int(time.time() * 1000),
        }
