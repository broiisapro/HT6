import { existsSync } from "node:fs";
import { emitKeypressEvents } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { startServer } from "./server.js";
import { startPlayback } from "./playback.js";
import { FallbackPlayer } from "./fallback-player.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.join(__dirname, "..", "assets");

async function main() {
  const zones = await listZones();
  if (zones.length === 0) {
    console.error(`[index] no zone folders found under ${ASSETS_DIR}. See assets/README.md.`);
    process.exitCode = 1;
    return;
  }

  const playable = await listPlayableZones();
  if (playable.length === 0) {
    console.error(`[index] every zone folder is empty under ${ASSETS_DIR}. Add tracks to at least one zone.`);
    process.exitCode = 1;
    return;
  }
  const empty = zones.filter((zone) => !playable.includes(zone));
  if (empty.length > 0) {
    console.warn(`[index] zone(s) with no tracks yet (not selectable until filled): ${empty.join(", ")}`);
  }

  // ── Auto-start polar-phone-relay ───────────────────────────────────────
  // Spawns the biometrics polar-phone-relay so `npm start` brings up the
  // full stack in one command. iPhone app POSTs HR to http://<mac-ip>:8766/hr;
  // relay smooths + forwards as WS biometric messages to this server on 8765.
  const BIOMETRICS_DIR = path.join(__dirname, "..", "..", "biometrics");
  const PYTHON = path.join(BIOMETRICS_DIR, ".venv", "bin", "python");
  const RELAY_SCRIPT = path.join(BIOMETRICS_DIR, "run.py");

  if (existsSync(PYTHON) && existsSync(RELAY_SCRIPT)) {
    const relay = spawn(PYTHON, [
      RELAY_SCRIPT,
      "--source", "polar-phone-relay",
      "--websocket-url", "ws://127.0.0.1:8765",
    ], { cwd: BIOMETRICS_DIR, stdio: "inherit" });
    relay.on("error", (err) => console.error("[polar-relay] failed to start:", err.message));
    relay.on("exit", (code) => console.log(`[polar-relay] exited (code=${code})`));
    // Kill relay when this process exits.
    process.on("exit", () => relay.kill());
    process.on("SIGINT", () => { relay.kill(); process.exit(0); });
    console.log("[polar-relay] started — iPhone app → POST http://<mac-ip>:8766/hr");
  } else {
    console.warn("[polar-relay] biometrics/.venv not found — skipping auto-start (run manually if needed)");
  }

  // Epic 3: start playback first so we have sourceNode to pass to the server.
  // (Order changed from Epic 2: server was first, but the server now needs the
  // sourceNode returned by startPlayback() to drive playbackRate on biometric
  // messages. Playback is fast — decoding ~60 s of WAV typically takes <50 ms
  // — so this doesn't meaningfully delay the server becoming available.)
  // Epic 6: also pass through filterNode/pannerNode/lfo for pencil-driven
  // melody/timbre.
  const { sourceNode, filterNode, pannerNode, lfo, playBeat, applyStressIntensity, playPluck, switchBed } = await startPlayback();

  // Epic 8: fallback player replays pre-recorded sequences when live input
  // fails. Toggled by pressing f in this terminal.
  const fallbackPlayer = new FallbackPlayer({ sourceNode, filterNode, pannerNode, lfo });

  // Epic 9: switchBed is passed so zone profile crossfades apply to the real
  // audio nodes. The server's mode/intention state is driven by WS messages.
  const { setOppositeMood, setStaticMode } = startServer({ sourceNode, filterNode, pannerNode, lfo, fallbackPlayer, playBeat, applyStressIntensity, playPluck, switchBed });

  // Track toggle states locally so the keypress handler can flip them.
  let oppositeMoodOn = false;
  let staticModeOn = false;

  // ── Keypress handler (Epic 8 fallback trigger) ────────────────────────────
  // f  → toggle fallback on/off
  // Ctrl+C → clean exit (readline raw mode swallows it otherwise)
  if (process.stdin.isTTY) {
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.on("keypress", (str, key) => {
      if (!key) return;
      if (key.ctrl && key.name === "c") {
        console.log("[index] Ctrl+C — shutting down.");
        process.exit(0);
      }
      if (key.name === "f") {
        if (fallbackPlayer.active) {
          fallbackPlayer.stop();
        } else {
          fallbackPlayer.start();
        }
      }
      // Epic 8.5: 'o' toggles opposite-mood mapping; 's' toggles static mode.
      if (key.name === "o") {
        oppositeMoodOn = !oppositeMoodOn;
        setOppositeMood(oppositeMoodOn);
      }
      if (key.name === "s") {
        staticModeOn = !staticModeOn;
        setStaticMode(staticModeOn);
      }
    });
    console.log("[index] keys: f=fallback  o=opposite-mood  s=static/freeze  Ctrl+C=exit");
  } else {
    // Non-TTY environment (piped input, CI, tests) — keypress handler is
    // skipped; fallback can still be toggled programmatically via
    // fallbackPlayer.start() / .stop() in test code.
    console.log("[index] stdin is not a TTY — keypress fallback trigger disabled.");
  }
}

main().catch((err) => {
  console.error("[index] fatal error:", err);
  process.exitCode = 1;
});
