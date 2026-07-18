import { WebSocketServer } from "ws";

const HOST = "0.0.0.0";
const PORT = 8765;

/**
 * Contract WebSocket server (see ../../contracts/README.md).
 * Epic 2 scope: accept connections, log every message. No handling logic —
 * that's Epic 3 (biometric -> tempo) and Epic 6 (pencil -> melody).
 *
 * To add handling later: branch on `message.type` inside the "message"
 * listener below ("biometric" | "pencil") and call into the playback
 * module (see playback.js) instead of just logging.
 */
export function startServer() {
  const wss = new WebSocketServer({ host: HOST, port: PORT });

  wss.on("listening", () => {
    console.log(`[server] contract WebSocket server listening on ws://${HOST}:${PORT}`);
  });

  wss.on("connection", (socket, req) => {
    const remote = req.socket.remoteAddress;
    console.log(`[server] client connected from ${remote}`);

    socket.on("message", (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch (err) {
        console.warn(`[server] received non-JSON message from ${remote}: ${raw}`);
        return;
      }
      console.log(`[server] message from ${remote}:`, message);
    });

    socket.on("close", () => {
      console.log(`[server] client disconnected: ${remote}`);
    });

    socket.on("error", (err) => {
      console.error(`[server] socket error from ${remote}:`, err.message);
    });
  });

  wss.on("error", (err) => {
    console.error("[server] server error:", err.message);
  });

  return wss;
}
