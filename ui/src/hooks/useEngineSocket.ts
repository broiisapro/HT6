import { useCallback, useEffect, useRef, useState } from "react";
import type { EngineMode, Intention, StateBroadcast, Zone } from "../types";

export type ConnectionStatus = "connecting" | "open" | "closed";

const PORT = 8765;
const MIN_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8000;

function engineUrl() {
  // Never hardcode localhost — the performer's iPad/phone opens this page
  // from another device on the LAN, so the WebSocket target has to follow
  // whatever host the page itself was loaded from.
  return `ws://${window.location.hostname}:${PORT}/?client=ui`;
}

/**
 * Connects to the audio-engine contract WebSocket as a tagged UI client,
 * auto-reconnects with exponential backoff on drop, sends `mode` messages,
 * and exposes the latest `state` broadcast as the source of truth. A tap
 * highlights optimistically in the UI (see App.tsx); this hook only reports
 * what the server actually confirmed.
 */
export function useEngineSocket() {
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [state, setState] = useState<StateBroadcast | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const backoffRef = useRef(MIN_BACKOFF_MS);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unmountedRef = useRef(false);

  useEffect(() => {
    unmountedRef.current = false;

    function connect() {
      if (unmountedRef.current) return;
      setStatus("connecting");
      const socket = new WebSocket(engineUrl());
      socketRef.current = socket;

      socket.addEventListener("open", () => {
        backoffRef.current = MIN_BACKOFF_MS;
        setStatus("open");
      });

      socket.addEventListener("message", (event) => {
        try {
          const message = JSON.parse(event.data as string);
          if (message.type === "state") setState(message as StateBroadcast);
        } catch {
          // Ignore malformed frames rather than crashing the control surface.
        }
      });

      socket.addEventListener("close", () => {
        if (unmountedRef.current) return;
        setStatus("closed");
        reconnectTimerRef.current = setTimeout(connect, backoffRef.current);
        backoffRef.current = Math.min(backoffRef.current * 2, MAX_BACKOFF_MS);
      });

      socket.addEventListener("error", () => socket.close());
    }

    connect();

    return () => {
      unmountedRef.current = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      socketRef.current?.close();
    };
  }, []);

  const sendSimulateHeartAttack = useCallback(() => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify({ type: "simulate-heart-attack", timestamp: Date.now() }));
    return true;
  }, []);

  const sendMode = useCallback(
    (mode: EngineMode, zone: Zone | null, intention: Intention | null) => {
      const socket = socketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) return false;
      socket.send(JSON.stringify({ type: "mode", mode, zone, intention, timestamp: Date.now() }));
      return true;
    },
    []
  );

  return { status, state, sendMode, sendSimulateHeartAttack };
}
