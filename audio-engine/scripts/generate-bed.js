import "dotenv/config";
import { fal } from "@fal-ai/client";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * One-time script — NOT part of the live server. Run manually:
 *   npm run generate-bed
 *
 * Calls fal.ai's CassetteAI music-generator to produce a short instrumental
 * bed and saves it to audio-engine/assets/bed.wav, committed to the repo.
 * The live engine (src/playback.js) only ever reads that committed file —
 * it never calls fal.ai at runtime.
 *
 * Model choice: CassetteAI/music-generator (see docs/epic-2-audio-engine-scaffold.md
 * for the full reasoning) — simple {prompt, duration} input, fast generation,
 * 44.1kHz stereo WAV output, and the prompt format supports specifying key/tempo
 * directly, which matters for a bed that needs to loop cleanly.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = path.join(__dirname, "..", "assets", "bed.wav");

const PROMPT =
  "Warm, minimal instrumental loop bed for a live performance demo. " +
  "Steady four-on-the-floor pulse, soft analog pads, gentle plucked synth arpeggio, " +
  "no vocals, no drums fills or breaks, consistent energy throughout so it loops seamlessly. " +
  "Key: A minor, Tempo: 96 BPM.";
const DURATION_SECONDS = 60;

async function main() {
  if (!process.env.FAL_KEY) {
    throw new Error("FAL_KEY is not set. Copy .env.example to .env and fill in your fal.ai key.");
  }

  console.log("[generate-bed] requesting bed from CassetteAI/music-generator...");
  console.log(`[generate-bed] prompt: ${PROMPT}`);
  console.log(`[generate-bed] duration: ${DURATION_SECONDS}s`);

  const result = await fal.subscribe("CassetteAI/music-generator", {
    input: {
      prompt: PROMPT,
      duration: DURATION_SECONDS,
    },
    logs: true,
    onQueueUpdate: (update) => {
      if (update.status === "IN_PROGRESS") {
        update.logs.map((log) => log.message).forEach((msg) => console.log(`[fal] ${msg}`));
      }
    },
  });

  const audioUrl = result?.data?.audio_file?.url;
  if (!audioUrl) {
    throw new Error(`Unexpected response shape from fal.ai: ${JSON.stringify(result)}`);
  }

  console.log(`[generate-bed] downloading generated audio from ${audioUrl}`);
  const response = await fetch(audioUrl);
  if (!response.ok) {
    throw new Error(`Failed to download generated audio: ${response.status} ${response.statusText}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());

  await writeFile(OUTPUT_PATH, buffer);
  console.log(`[generate-bed] saved bed to ${OUTPUT_PATH} (${buffer.length} bytes)`);
  console.log("[generate-bed] done. Commit this file to the repo.");
}

main().catch((err) => {
  console.error("[generate-bed] failed:", err);
  process.exitCode = 1;
});
