from __future__ import annotations

import json
import logging
import socket
import threading
import time
from collections import deque
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Deque, Optional

from human_midi_biometrics.biometric_source import BiometricSource
from human_midi_biometrics.smoothing import ArBpmSmoother, OutlierGate

logger = logging.getLogger(__name__)


@dataclass
class PolarPhoneRelayConfig:
    host: str = "0.0.0.0"
    port: int = 8766
    buffer_size: int = 256
    stale_timeout_seconds: float = 5.0


class PolarPhoneRelaySource(BiometricSource):
    def __init__(self, config: PolarPhoneRelayConfig | None = None) -> None:
        self.config = config or PolarPhoneRelayConfig()
        self._outlier_gate = OutlierGate()
        self._smoother = ArBpmSmoother(window_size=5)
        self._latest_bpm: Optional[float] = None
        self._last_rx_ts: Optional[float] = None
        self._raw_buffer: Deque[float] = deque(maxlen=self.config.buffer_size)
        self._lock = threading.Lock()
        self._server: Optional[ThreadingHTTPServer] = None
        self._server_thread: Optional[threading.Thread] = None

    async def start(self) -> None:
        source = self

        class RelayHandler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                if self.path != "/hr":
                    self.send_response(HTTPStatus.NOT_FOUND)
                    self.end_headers()
                    return
                content_length = int(self.headers.get("Content-Length", "0"))
                if content_length <= 0:
                    self.send_response(HTTPStatus.BAD_REQUEST)
                    self.end_headers()
                    return
                raw_body = self.rfile.read(content_length)
                try:
                    payload = json.loads(raw_body.decode("utf-8"))
                except Exception:
                    self.send_response(HTTPStatus.BAD_REQUEST)
                    self.end_headers()
                    return
                hr = payload.get("hr")
                try:
                    hr_value = float(hr)
                except (TypeError, ValueError):
                    self.send_response(HTTPStatus.BAD_REQUEST)
                    self.end_headers()
                    return
                source._ingest_hr(hr_value)
                self.send_response(HTTPStatus.NO_CONTENT)
                self.end_headers()

            def log_message(self, format: str, *args: object) -> None:
                return

        self._server = ThreadingHTTPServer((self.config.host, self.config.port), RelayHandler)
        self._server_thread = threading.Thread(
            target=self._server.serve_forever,
            name="polar-phone-relay-http",
            daemon=True,
        )
        self._server_thread.start()
        logger.info(
            "Polar phone relay listening on http://%s:%s/hr",
            self.config.host,
            self.config.port,
        )
        logger.info(
            "Configure iPhone relay target to: http://%s:%s/hr",
            _get_lan_ip(),
            self.config.port,
        )

    async def stop(self) -> None:
        if self._server:
            self._server.shutdown()
            self._server.server_close()
            self._server = None
        if self._server_thread:
            self._server_thread.join(timeout=2)
            self._server_thread = None

    def get_bpm(self) -> Optional[float]:
        with self._lock:
            if self._last_rx_ts is None:
                return None
            if time.time() - self._last_rx_ts > self.config.stale_timeout_seconds:
                return None
            return self._latest_bpm

    def _ingest_hr(self, hr_value: float) -> None:
        with self._lock:
            self._raw_buffer.append(hr_value)
            accepted = self._outlier_gate.filter(hr_value)
            if accepted is None:
                return
            smoothed = self._smoother.add(accepted)
            if smoothed is None:
                return
            self._latest_bpm = smoothed
            self._last_rx_ts = time.time()


def _get_lan_ip() -> str:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("8.8.8.8", 80))
        return sock.getsockname()[0]
    except OSError:
        return socket.gethostbyname(socket.gethostname())
    finally:
        sock.close()
