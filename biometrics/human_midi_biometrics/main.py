from __future__ import annotations

import argparse
import asyncio
import logging

from human_midi_biometrics.pipeline import BiometricPipeline, PipelineConfig
from human_midi_biometrics.sources.phone_camera import PhoneCameraPpgSource
from human_midi_biometrics.sources.polar_ble import PolarBleConfig, PolarBleSource
from human_midi_biometrics.sources.polar_phone_relay import (
    PolarPhoneRelayConfig,
    PolarPhoneRelaySource,
)
from human_midi_biometrics.sources.simulated import SimulatedBpmSource


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Human MIDI biometrics sender")
    parser.add_argument(
        "--source",
        choices=["phone-camera", "polar-ble", "polar-phone-relay", "simulated"],
        required=True,
        help="Biometric source implementation to run.",
    )
    parser.add_argument(
        "--websocket-url",
        default="ws://127.0.0.1:8765",
        help="WebSocket destination URL for contract messages.",
    )
    parser.add_argument(
        "--mock",
        action="store_true",
        help="Enable local mock mode (no websocket required).",
    )
    parser.add_argument(
        "--camera-index",
        type=int,
        default=0,
        help="Camera index for OpenCV capture.",
    )
    parser.add_argument(
        "--device-name-hint",
        default="Polar",
        help="Substring to find matching BLE device name during scan.",
    )
    parser.add_argument(
        "--relay-port",
        type=int,
        default=8766,
        help="Local HTTP port for Polar phone relay source.",
    )
    parser.add_argument(
        "--relay-host",
        default="0.0.0.0",
        help="Local bind host for Polar phone relay source.",
    )
    return parser.parse_args()


async def run() -> None:
    args = parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    if args.source == "phone-camera":
        source = PhoneCameraPpgSource(camera_index=args.camera_index)
    elif args.source == "simulated":
        source = SimulatedBpmSource()
    elif args.source == "polar-phone-relay":
        source = PolarPhoneRelaySource(
            config=PolarPhoneRelayConfig(
                host=args.relay_host,
                port=args.relay_port,
            )
        )
    else:
        source = PolarBleSource(config=PolarBleConfig(device_name_hint=args.device_name_hint))

    pipeline = BiometricPipeline(
        source=source,
        config=PipelineConfig(
            websocket_url=args.websocket_url,
            mock_mode=args.mock,
            send_interval_seconds=1.0,
        ),
    )
    await pipeline.run()


if __name__ == "__main__":
    asyncio.run(run())
