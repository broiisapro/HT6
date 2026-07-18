import path from "node:path";
import { fileURLToPath } from "node:url";
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

  startServer();
  await startPlayback();
}

main().catch((err) => {
  console.error("[index] fatal error:", err);
  process.exitCode = 1;
});
