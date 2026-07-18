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

  startServer();
  await startPlayback();
}

main().catch((err) => {
  console.error("[index] fatal error:", err);
  process.exitCode = 1;
});
