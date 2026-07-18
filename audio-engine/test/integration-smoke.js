/**
 * integration-smoke.js — Epic 7 integration validation
 *
 * Verifies the full server message pipeline with both biometric and pencil
 * clients connected simultaneously, without requiring real audio hardware.
 * Uses mock AudioParam/AudioNode stubs so the test runs headless.
 *
 * Run with:  node test/integration-smoke.js
 * Expected:  exits 0 with PASS summary; exits 1 on any assertion failure.
 */

import { WebSocket } from "ws";
import { startServer } from "../src/server.js";

// ── Minimal AudioParam/AudioNode stubs ──────────────────────────────────────
// node-web-audio-api is not loaded here (no AudioContext → no Core Audio
// dependency), so we stub the AudioParam methods the server actually calls.
function makeParam(defaultValue) {
  let value = defaultValue;
  return {
    get value() { return value; },
    set value(v) { value = v; },
    setTargetAtTime(target) { value = target; },  // immediate in stubs
  };
}

function makeAudioNode(paramNames, context) {
  const node = { context };
  for (const name of paramNames) {
    node[name] = makeParam(0);
  }
  return node;
}

// Shared stub AudioContext (only currentTime is used by server.js).
const stubContext = { currentTime: 0 };

const mockSourceNode  = makeAudioNode(["playbackRate"], stubContext);
const mockFilterNode  = { ...makeAudioNode([], stubContext), frequency: makeParam(8000), context: stubContext };
const mockPannerNode  = { ...makeAudioNode([], stubContext), pan: makeParam(0), context: stubContext };
const mockLfo         = { ...makeAudioNode([], stubContext), frequency: makeParam(0.5), context: stubContext };

// ── Capture server console output ───────────────────────────────────────────
const logLines = [];
const origLog  = console.log.bind(console);
const origWarn = console.warn.bind(console);
console.log  = (...a) => { const s = a.join(" "); logLines.push(s); origLog(s); };
console.warn = (...a) => { const s = a.join(" "); logLines.push(s); origWarn(s); };

// ── Start server with mock nodes ─────────────────────────────────────────────────────
// startServer() returns { wss, setOppositeMood, setStaticMode } — destructure wss.
const { wss } = startServer({
  sourceNode: mockSourceNode,
  filterNode: mockFilterNode,
  pannerNode: mockPannerNode,
  lfo: mockLfo,
  zoneDwellMs: 0,  // instant zone switches so rate stays BPM/BED_BPM as expected
});

// ── Helpers ──────────────────────────────────────────────────────────────────
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function wsConnect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on("open",  () => resolve(ws));
    ws.on("error", reject);
  });
}

function wsSend(ws, obj) {
  return new Promise((resolve, reject) => {
    ws.send(JSON.stringify(obj), err => err ? reject(err) : resolve());
  });
}

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  }
}

// ── Test sequence ────────────────────────────────────────────────────────────
async function runTests() {
  await delay(50);  // give server time to bind

  // ── Test 1: biometric client ─────────────────────────────────────────────
  const bioWs = await wsConnect("ws://127.0.0.1:8765");

  const bpmIn     = 85;
  const expectedRate = bpmIn / 96;   // 85/96 ≈ 0.8854
  await wsSend(bioWs, { type: "biometric", bpm: bpmIn, timestamp: Date.now() });
  await delay(30);

  assert(
    Math.abs(mockSourceNode.playbackRate.value - expectedRate) < 0.0001,
    `biometric 85 BPM → playbackRate ~${expectedRate.toFixed(4)}, got ${mockSourceNode.playbackRate.value.toFixed(4)}`
  );

  // ── Test 2: pencil client (tilt-based brightness) ────────────────────────
  const pencilWs = await wsConnect("ws://127.0.0.1:8765");

  const tilt     = 45;
  const velocity = 600;
  const x        = 590;                  // midpoint → pan ≈ 0
  await wsSend(pencilWs, {
    type: "pencil",
    pressure: 0.240,
    x,
    y: 400,
    velocity,
    tilt,
    timestamp: Date.now(),
  });
  await delay(30);

  // cutoff at tilt=45 → brightness01=0.5 → 300*(8000/300)^0.5 ≈ 1549 Hz
  const expectedCutoff = 300 * Math.pow(8000 / 300, 0.5);
  assert(
    Math.abs(mockFilterNode.frequency.value - expectedCutoff) < 5,
    `pencil tilt=45 → cutoff ~${expectedCutoff.toFixed(0)} Hz, got ${mockFilterNode.frequency.value.toFixed(0)} Hz`
  );

  // pan at x=590 of 1180 → pan ≈ 0
  assert(
    Math.abs(mockPannerNode.pan.value) < 0.01,
    `pencil x=${x} → pan ≈ 0, got ${mockPannerNode.pan.value.toFixed(3)}`
  );

  // ── Test 3: biometric while pencil is connected (interleave check) ────
  const bpmIn2    = 103;
  // The rate limiter caps BPM change at MAX_BPM_CHANGE_PER_SEC (10 BPM/s) so the
  // effective BPM after a short ~60ms gap is only slightly above bpmIn (85).
  // We assert the rate INCREASED toward bpmIn2/96 (message was applied) rather
  // than an exact value that depends on actual elapsed wall-clock time.
  const rateAfterFirst = bpmIn / 96;   // rate from test 1
  await wsSend(bioWs, { type: "biometric", bpm: bpmIn2, timestamp: Date.now() });
  await delay(30);

  assert(
    mockSourceNode.playbackRate.value > rateAfterFirst,
    `interleaved biometric ${bpmIn2} BPM should increase rate above ${rateAfterFirst.toFixed(4)}, got ${mockSourceNode.playbackRate.value.toFixed(4)}`
  );

  // Pencil params must be unchanged (tempo change must not affect melody nodes).
  assert(
    Math.abs(mockFilterNode.frequency.value - expectedCutoff) < 5,
    `filter unchanged after biometric update: expected ~${expectedCutoff.toFixed(0)}, got ${mockFilterNode.frequency.value.toFixed(0)}`
  );

  // ── Test 4: pencil tilt:null fallback ─────────────────────────────────────
  await wsSend(pencilWs, {
    type: "pencil",
    pressure: 0.240,
    x: 590,
    y: 400,
    velocity: 1000,
    tilt: null,
    timestamp: Date.now(),
  });
  await delay(30);

  assert(
    !Number.isNaN(mockFilterNode.frequency.value),
    "tilt:null must not produce NaN cutoff"
  );

  // ── Test 5: per-connection smoother isolation ─────────────────────────────
  // Connect a second pencil client — it should get its own fresh EMA state.
  const pencilWs2 = await wsConnect("ws://127.0.0.1:8765");
  const firstVel = 2000;   // high velocity on second client's first message
  await wsSend(pencilWs2, {
    type: "pencil", pressure: 0.240, x: 100, y: 100,
    velocity: firstVel, tilt: 45, timestamp: Date.now(),
  });
  await delay(30);

  // EMA on first message: smoothed === null → returns raw = firstVel.
  // tremoloHz = 0.5 + (firstVel/2000) * (8-0.5) = 0.5 + 7.5 = 8 Hz
  assert(
    Math.abs(mockLfo.frequency.value - 8) < 0.1,
    `fresh smoother on second client: velocity=${firstVel} → tremolo should be ~8Hz, got ${mockLfo.frequency.value.toFixed(2)}Hz`
  );

  // ── Test 6: malformed message ignored ─────────────────────────────────────
  const rateBeforeMalformed = mockSourceNode.playbackRate.value;
  await wsSend(bioWs, { type: "biometric", bpm: "not-a-number", timestamp: Date.now() });
  await delay(30);
  assert(
    mockSourceNode.playbackRate.value === rateBeforeMalformed,
    "malformed biometric message (non-numeric bpm) must be ignored"
  );

  // ── Done ──────────────────────────────────────────────────────────────────
  bioWs.close();
  pencilWs.close();
  pencilWs2.close();
  wss.close(() => {
    const failed = process.exitCode === 1;
    origLog(failed ? "\n⚠ INTEGRATION SMOKE: some assertions failed (see above)" : "\n✔ INTEGRATION SMOKE: all assertions passed");
  });
}

runTests().catch(err => {
  console.error("integration-smoke fatal:", err);
  process.exitCode = 1;
  wss.close();
});
