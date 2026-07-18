/**
 * fallback-smoke.js — Epic 8 fallback validation
 *
 * Exercises the FallbackPlayer and the server.js fallbackPlayer integration
 * without requiring real audio hardware. Uses the same mock
 * AudioParam/AudioNode stubs as integration-smoke.js.
 *
 * Scenarios covered:
 *   1. Live mode: biometric + pencil messages apply correctly (baseline).
 *   2. Fallback activated: live messages are dropped; fallback drives params.
 *   3. Deliberate-failure simulation: live biometric client disconnected mid-
 *      run, fallback triggered → audio params continue changing from fallback.
 *   4. Fallback deactivated: live messages apply again; stale timers resume.
 *
 * Run with:  node test/fallback-smoke.js
 * Expected:  exits 0 with ✔ FALLBACK SMOKE: all assertions passed
 *            exits 1 on any assertion failure.
 */

import { WebSocket } from "ws";
import { startServer } from "../src/server.js";
import { FallbackPlayer } from "../src/fallback-player.js";

// ── Minimal AudioParam/AudioNode stubs ─────────────────────────────────────
function makeParam(defaultValue) {
  let value = defaultValue;
  return {
    get value() { return value; },
    set value(v) { value = v; },
    setTargetAtTime(target) { value = target; },
  };
}
const stubContext = { currentTime: 0 };
function makeNode(paramNames) {
  const node = { context: stubContext };
  for (const name of paramNames) node[name] = makeParam(0);
  return node;
}

const mockSourceNode = makeNode(["playbackRate"]);
const mockFilterNode = { context: stubContext, frequency: makeParam(8000) };
const mockPannerNode = { context: stubContext, pan: makeParam(0) };
const mockLfo        = { context: stubContext, frequency: makeParam(0.5) };

// ── Capture console output ──────────────────────────────────────────────────
const logLines = [];
const origLog  = console.log.bind(console);
const origWarn = console.warn.bind(console);
console.log  = (...a) => { const s = a.join(" "); logLines.push(s); origLog(s); };
console.warn = (...a) => { const s = a.join(" "); logLines.push(s); origWarn(s); };

// ── Helpers ─────────────────────────────────────────────────────────────────
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
    origLog(`FAIL: ${msg}`);
    process.exitCode = 1;
  }
}

// ── Instantiate FallbackPlayer with mock nodes ──────────────────────────────
const fallbackPlayer = new FallbackPlayer({
  sourceNode: mockSourceNode,
  filterNode: mockFilterNode,
  pannerNode: mockPannerNode,
  lfo: mockLfo,
});

// ── Start server with fallback wired up ──────────────────────────────────────
// startServer() returns { wss, setOppositeMood, setStaticMode } — destructure wss.
const { wss } = startServer({
  sourceNode: mockSourceNode,
  filterNode: mockFilterNode,
  pannerNode: mockPannerNode,
  lfo: mockLfo,
  fallbackPlayer,
  zoneDwellMs: 0,  // instant zone switches for deterministic test behaviour
});

// ── Test sequence ────────────────────────────────────────────────────────────
async function runTests() {
  await delay(50); // give server time to bind

  // ── Scenario 1: Live mode baseline ────────────────────────────────────────
  const bioWs = await wsConnect("ws://127.0.0.1:8765");

  // 1a. Live biometric message is applied normally.
  const liveBpm = 85;
  const expectedLiveRate = liveBpm / 96; // ≈ 0.8854
  await wsSend(bioWs, { type: "biometric", bpm: liveBpm, timestamp: Date.now() });
  await delay(30);

  assert(
    Math.abs(mockSourceNode.playbackRate.value - expectedLiveRate) < 0.0001,
    `[S1a] live biometric 85 BPM → playbackRate ~${expectedLiveRate.toFixed(4)}, ` +
    `got ${mockSourceNode.playbackRate.value.toFixed(4)}`
  );

  // 1b. Live pencil message is applied normally.
  const pencilWs = await wsConnect("ws://127.0.0.1:8765");
  await wsSend(pencilWs, {
    type: "pencil", pressure: 0.240, x: 590, y: 400,
    velocity: 400, tilt: 45, timestamp: Date.now(),
  });
  await delay(30);

  // tilt=45 → brightness01=0.5 → cutoff = 300*(8000/300)^0.5 ≈ 1549 Hz
  const expectedCutoff = 300 * Math.pow(8000 / 300, 0.5);
  assert(
    Math.abs(mockFilterNode.frequency.value - expectedCutoff) < 5,
    `[S1b] live pencil tilt=45 → cutoff ~${expectedCutoff.toFixed(0)} Hz, ` +
    `got ${mockFilterNode.frequency.value.toFixed(0)} Hz`
  );

  // ── Scenario 2: Fallback activation — live messages dropped ───────────────
  //
  // This is the "deliberate-failure rehearsal" required by the Epic 8 DoD:
  // we simulate a mid-demo Polar Bluetooth drop (by disconnecting bioWs),
  // then trigger the fallback and confirm it takes over.

  bioWs.close();      // simulate Polar BT drop
  await delay(50);

  const rateBeforeFallback = mockSourceNode.playbackRate.value;

  fallbackPlayer.start();
  assert(fallbackPlayer.active, "[S2a] fallbackPlayer.active should be true after start()");

  // 2b. The fallback should apply its first biometric message almost
  // immediately (scheduleBio fires synchronously then defers the next via
  // setTimeout(0..interval_ms)).  Wait a tick for the first _applyBio call.
  await delay(50);

  // First fallback biometric BPM is 75.0 → playbackRate = 75/96 ≈ 0.7813
  const expectedFallbackRate = 75.0 / 96;
  assert(
    Math.abs(mockSourceNode.playbackRate.value - expectedFallbackRate) < 0.0002,
    `[S2b] fallback first BPM 75 → playbackRate ~${expectedFallbackRate.toFixed(4)}, ` +
    `got ${mockSourceNode.playbackRate.value.toFixed(4)}`
  );

  // 2c. Live message sent while fallback active must be dropped (param unchanged).
  const reconnectedBioWs = await wsConnect("ws://127.0.0.1:8765");
  await wsSend(reconnectedBioWs, { type: "biometric", bpm: 120, timestamp: Date.now() });
  await delay(30);

  // If the live message were applied, playbackRate would jump to 120/96 ≈ 1.25.
  // It must remain near the fallback value (75/96), not 1.25.
  assert(
    mockSourceNode.playbackRate.value < 1.0,
    `[S2c] live message while fallback active must be dropped — ` +
    `playbackRate should stay near ${expectedFallbackRate.toFixed(4)}, ` +
    `got ${mockSourceNode.playbackRate.value.toFixed(4)}`
  );

  // 2d. Confirm the log shows the "fallback active — live message dropped" line.
  assert(
    logLines.some(l => l.includes("fallback active") && l.includes("live message dropped")),
    "[S2d] server must log 'fallback active — live message dropped' for the dropped message"
  );

  // 2e. Wait long enough for several fallback bio steps so we can confirm
  //     the sequence advances (BPM 75 → 75.5 → 76.0 → ...).
  await delay(2200); // ~2 bio steps
  const rateAfterFallbackSteps = mockSourceNode.playbackRate.value;
  assert(
    rateAfterFallbackSteps > expectedFallbackRate,
    `[S2e] fallback BPM should advance past 75 after 2s — ` +
    `expected > ${expectedFallbackRate.toFixed(4)}, got ${rateAfterFallbackSteps.toFixed(4)}`
  );

  // ── Scenario 3: Fallback deactivation — live messages apply again ─────────
  fallbackPlayer.stop();
  assert(!fallbackPlayer.active, "[S3a] fallbackPlayer.active should be false after stop()");

  await delay(30);

  // 3b. Send a live biometric message — must be applied now.
  // The rate limiter caps BPM change at 10 BPM/s from the pre-fallback value (85).
  // After ~2s elapsed since the last rate-limiter update, dt is capped at 1s,
  // so effective BPM = 85+10 = 95, giving rate = 95/96 ≈ 0.99.
  // The key assertion: rate jumped well above the fallback BPM range (~0.78–0.82)
  // meaning live input has resumed. Exact value depends on dt.
  await wsSend(reconnectedBioWs, { type: "biometric", bpm: 103, timestamp: Date.now() });
  await delay(30);

  assert(
    mockSourceNode.playbackRate.value > 0.9,
    `[S3b] live 103 BPM after fallback deactivated should push rate > 0.9 (rate limiter caps to ~95/96), ` +
    `got ${mockSourceNode.playbackRate.value.toFixed(4)}`
  );

  // ── Done ──────────────────────────────────────────────────────────────────
  reconnectedBioWs.close();
  pencilWs.close();
  wss.close(() => {
    const failed = process.exitCode === 1;
    origLog(
      failed
        ? "\n⚠ FALLBACK SMOKE: some assertions failed (see above)"
        : "\n✔ FALLBACK SMOKE: all assertions passed"
    );
  });
}

runTests().catch(err => {
  origLog("fallback-smoke fatal:", err);
  process.exitCode = 1;
  wss.close();
});
