import path from "node:path";
import { fileURLToPath } from "node:url";
import { emitKeypressEvents } from "node:readline";
import { startServer } from "./server.js";
import { startPlayback, listZones, listPlayableZones } from "./playback.js";
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

  // Playback starts first so its handle (switchBed/setTempo/setMelodyParams)
  // is ready before the server can receive its first biometric/pencil message.
  // Items 3, 4, 5: playback also exposes playBeat, applyStressIntensity, playPluck,
  // and the effects-chain nodes (filterNode, pannerNode, lfo) for FallbackPlayer.
  const playback = await startPlayback();
  const { playBeat, applyStressIntensity, playPluck, filterNode, pannerNode, lfo } = playback;

  // Epic 8: fallback player replays pre-recorded sequences when live input
  // fails. Toggled by pressing f in this terminal.
  // FallbackPlayer uses setPlaybackRate callback (= playback.setTempo) and
  // direct node refs for melody/timbre control.
  const fallbackPlayer = new FallbackPlayer({
    setPlaybackRate: (rate) => playback.setTempo(rate),
    filterNode,
    pannerNode,
    lfo,
  });

  const { setOppositeMood, setStaticMode } = startServer({
    playback,
    fallbackPlayer,
    playBeat,
    applyStressIntensity,
    playPluck,
  });

  // Track toggle states locally so the keypress handler can flip them.
  let oppositeMoodOn = false;
  let staticModeOn   = false;

  // ── Keypress handler ──────────────────────────────────────────────────────
  //  f  → toggle fallback on/off          (Epic 8)
  //  o  → toggle opposite-mood mapping    (Epic 8.5)
  //  s  → toggle static/freeze mode       (Epic 8.5)
  //  Ctrl+C → clean exit (readline raw mode swallows it otherwise)
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
