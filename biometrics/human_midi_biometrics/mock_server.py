from __future__ import annotations

import asyncio
import json
import logging

import websockets

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)


async def handler(websocket):
    async for message in websocket:
        try:
            payload = json.loads(message)
        except json.JSONDecodeError:
            logger.error("Received non-JSON message: %s", message)
            continue
        logger.info("Received message: %s", payload)


async def main() -> None:
    async with websockets.serve(handler, "127.0.0.1", 8765):
        logger.info("Mock logging WebSocket server listening at ws://127.0.0.1:8765")
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
