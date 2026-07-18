import { existsSync } from "node:fs";
import { emitKeypressEvents } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./server.js";
import { startPlayback } from "./playback.js";
import { FallbackPlayer } from "./fallback-player.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BED_PATH = path.join(__dirname, "..", "assets", "bed.wav");

async function main() {
  if (!existsSync(BED_PATH)) {
    console.error(
      `[index] no bed found at ${BED_PATH}. Run "npm run generate-bed" first (requires FAL_KEY in .env).`
    );
    process.exitCode = 1;
    return;
  }

  // Epic 3: start playback first so we have sourceNode to pass to the server.
  // (Order changed from Epic 2: server was first, but the server now needs the
  // sourceNode returned by startPlayback() to drive playbackRate on biometric
  // messages. Playback is fast — decoding ~60 s of WAV typically takes <50 ms
  // — so this doesn't meaningfully delay the server becoming available.)
  // Epic 6: also pass through filterNode/pannerNode/lfo for pencil-driven
  // melody/timbre.
  const { sourceNode, filterNode, pannerNode, lfo } = await startPlayback();

  // Epic 8: fallback player replays pre-recorded sequences when live input
  // fails. Toggled by pressing f in this terminal.
  const fallbackPlayer = new FallbackPlayer({ sourceNode, filterNode, pannerNode, lfo });

  const { setOppositeMood, setStaticMode } = startServer({ sourceNode, filterNode, pannerNode, lfo, fallbackPlayer });

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
