#!/usr/bin/env node
// test-server.js — logging WebSocket server for Epic 5 verification
//
// Listens on ws://localhost:<port> (default 8765), prints every received
// pencil message and validates it against the frozen contract shape.
//
// Usage:
//   node test-server.js [port]        # or: npm run test-server
//
// Requires the `ws` package: npm install

'use strict';

const { WebSocketServer } = require('ws');

const PORT = parseInt(process.argv[2] || '8765', 10);
const REQUIRED_KEYS = ['type', 'pressure', 'x', 'y', 'velocity', 'tilt', 'timestamp'];

const wss = new WebSocketServer({ port: PORT });
console.log(`[test-server] Listening on ws://localhost:${PORT}`);
console.log(`[test-server] Point the pencil client at ws://<this-mac-ip>:${PORT} and draw.`);
console.log(`[test-server] Ctrl-C to stop.\n`);

wss.on('connection', (socket, req) => {
  const remote = req.socket.remoteAddress || 'unknown';
  let msgCount = 0;
  let firstTs = null;
  console.log(`[test-server] ++ connected: ${remote}`);

  socket.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (_) {
      console.error(`  [INVALID JSON] ${raw}`);
      return;
    }

    // Shape validation
    const missing = REQUIRED_KEYS.filter(k => !(k in msg));
    if (missing.length) {
      console.error(`  [MISSING KEYS: ${missing.join(', ')}] ${raw}`);
      return;
    }
    if (msg.type !== 'pencil') {
      console.warn(`  [UNEXPECTED TYPE: ${msg.type}] ${raw}`);
    }

    msgCount++;
    if (!firstTs) firstTs = msg.timestamp;

    const elapsed = ((msg.timestamp - firstTs) / 1000).toFixed(2).padStart(6);
    const n       = msgCount.toString().padStart(5);
    const pres    = msg.pressure.toFixed(3);
    const x       = msg.x.toFixed(1).padStart(7);
    const y       = msg.y.toFixed(1).padStart(7);
    const vel     = msg.velocity.toFixed(1).padStart(8);
    const tilt    = msg.tilt === null ? '    null' : msg.tilt.toFixed(2).padStart(8);

    console.log(`  [${n}] +${elapsed}s  pres=${pres}  x=${x}  y=${y}  vel=${vel}  tilt=${tilt}`);
  });

  socket.on('close', () => {
    const rate = firstTs && msgCount > 1
      ? (msgCount / ((Date.now() - firstTs) / 1000)).toFixed(1) + ' msg/s'
      : 'n/a';
    console.log(`[test-server] -- disconnected: ${remote} (${msgCount} msgs, avg ${rate})\n`);
  });

  socket.on('error', (err) => {
    console.error(`[test-server] socket error from ${remote}: ${err.message}`);
  });
});

wss.on('error', (err) => {
  console.error(`[test-server] fatal: ${err.message}`);
  process.exit(1);
});
