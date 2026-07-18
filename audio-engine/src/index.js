import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./server.js";
import { startPlayback } from "./playback.js";

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
  // Presage stress-layer: also pass through dryGain/wetGain for stress-driven
  // drive/tension mix.
  const { sourceNode, filterNode, pannerNode, lfo, dryGain, wetGain } = await startPlayback();
  startServer({ sourceNode, filterNode, pannerNode, lfo, dryGain, wetGain });
}

main().catch((err) => {
  console.error("[index] fatal error:", err);
  process.exitCode = 1;
});
