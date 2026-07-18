import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { startServer } from "./server.js";
import { startPlayback, listZones, listPlayableZones } from "./playback.js";

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

  // Playback starts first so its handle (switchBed/setTempo/setMelodyParams)
  // is ready before the server can receive its first biometric/pencil message.
  const playback = await startPlayback();
  startServer({ playback });
}

main().catch((err) => {
  console.error("[index] fatal error:", err);
  process.exitCode = 1;
});
