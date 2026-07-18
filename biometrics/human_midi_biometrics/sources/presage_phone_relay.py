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
from human_midi_biometrics.smoothing import RollingBpmSmoother

logger = logging.getLogger(__name__)


@dataclass
class PresagePhoneRelayConfig:
    host: str = "0.0.0.0"
    port: int = 8767
    stale_timeout_seconds: float = 5.0
    # The relay expects the iPhone app to forward SmartSpectra's raw HRV
    # RMSSD (metrics.cardio.hrv.rmssd in the Swift SDK, milliseconds) as-is --
    # confirmed from Presage's own iOS quickstart sample code, NOT a
    # pre-computed "stress index" as originally assumed here. RMSSD is
    # *inversely* related to stress: LOWER RMSSD means more stressed, HIGHER
    # means calmer -- get_stress() inverts it accordingly. rmssd_min_ms/max_ms
    # are an UNVERIFIED placeholder typical adult resting range; recalibrate
    # once real readings are available (see docs/presage-biometric-source.md).
    # Matches presage_cli.py's defaults so both Presage paths normalize
    # consistently.
    rmssd_min_ms: float = 15.0
    rmssd_max_ms: float = 100.0


class PresagePhoneRelaySource(BiometricSource):
    """Receives pulse-rate and HRV (RMSSD) readings relayed from an iPhone
    running Presage's SmartSpectra example app (or a light patch of it), over
    local HTTP: POST /bpm with JSON {"bpm": <number>, "hrv_rmssd_ms":
    <number|omitted>}.

    Presage's SDK is Swift-only on iOS -- same shape of problem the Polar
    integration already solved: rather than write custom Swift against an
    SDK nobody on the team has experience with, run Presage's own official
    example app on the phone and have it (or a small patch to it) POST
    readings here. Mirrors polar_phone_relay.py's approach exactly, extended
    with the optional hrv_rmssd_ms field.
    """

    def __init__(self, config: Optional[PresagePhoneRelayConfig] = None) -> None:
        self.config = config or PresagePhoneRelayConfig()
        self._smoother = RollingBpmSmoother(window_size=5)
        # RollingBpmSmoother hardcodes a 40-180 bpm-shaped range check, so it
        # can't be reused for RMSSD (different scale entirely) -- a plain
        # rolling mean over raw readings, normalized/inverted afterward.
        self._hrv_window: Deque[float] = deque(maxlen=5)
        self._latest_bpm: Optional[float] = None
        self._latest_stress: Optional[float] = None
        self._last_rx_ts: Optional[float] = None
        self._lock = threading.Lock()
        self._server: Optional[ThreadingHTTPServer] = None
        self._server_thread: Optional[threading.Thread] = None

    async def start(self) -> None:
        source = self

        class RelayHandler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                if self.path != "/bpm":
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
                try:
                    bpm_value = float(payload.get("bpm"))
                except (TypeError, ValueError):
                    self.send_response(HTTPStatus.BAD_REQUEST)
                    self.end_headers()
                    return

                raw_rmssd = payload.get("hrv_rmssd_ms")
                rmssd_value: Optional[float] = None
                if raw_rmssd is not None:
                    try:
                        rmssd_value = float(raw_rmssd)
                    except (TypeError, ValueError):
                        rmssd_value = None

                source._ingest(bpm_value, rmssd_value)
                self.send_response(HTTPStatus.NO_CONTENT)
                self.end_headers()

            def log_message(self, format: str, *args: object) -> None:
                return

        self._server = ThreadingHTTPServer((self.config.host, self.config.port), RelayHandler)
        self._server_thread = threading.Thread(
            target=self._server.serve_forever,
            name="presage-phone-relay-http",
            daemon=True,
        )
        self._server_thread.start()
        logger.info(
            "Presage phone relay listening on http://%s:%s/bpm",
            self.config.host,
            self.config.port,
        )
        logger.info(
            "Point the iPhone app's relay target at: http://%s:%s/bpm",
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

    def get_stress(self) -> Optional[float]:
        with self._lock:
            if self._last_rx_ts is None:
                return None
            if time.time() - self._last_rx_ts > self.config.stale_timeout_seconds:
                return None
            return self._latest_stress

    def _ingest(self, bpm_value: float, raw_rmssd: Optional[float]) -> None:
        with self._lock:
            smoothed = self._smoother.add(bpm_value)
            if smoothed is None:
                return
            self._latest_bpm = smoothed
            self._last_rx_ts = time.time()

            if raw_rmssd is not None:
                self._hrv_window.append(raw_rmssd)
                mean_rmssd = sum(self._hrv_window) / len(self._hrv_window)
                span = self.config.rmssd_max_ms - self.config.rmssd_min_ms
                normalized = (mean_rmssd - self.config.rmssd_min_ms) / span if span else 0.0
                normalized = max(0.0, min(1.0, normalized))
                # Invert: low RMSSD (little beat-to-beat variability) = high
                # stress; high RMSSD (relaxed) = low stress.
                self._latest_stress = 1.0 - normalized


def _get_lan_ip() -> str:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("8.8.8.8", 80))
        return sock.getsockname()[0]
    except OSError:
        return socket.gethostbyname(socket.gethostname())
    finally:
        sock.close()
