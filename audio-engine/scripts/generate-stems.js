/**
 * generate-stems.js — Epic 9: fal.ai Stem Generation
 *
 * Generates three genuinely distinct mood stems via fal.ai's
 * CassetteAI/music-generator. All are A minor, 96 BPM so they are
 * musically compatible with the main bed and the bpmToPlaybackRate()
 * mapping continues to work.
 *
 * Usage: FAL_KEY=xxx npm run generate-stems
 * (or add FAL_KEY to audio-engine/.env and run: npm run generate-stems)
 *
 * Output (overwrites the offline-processed versions):
 *   audio-engine/assets/stem-calm.wav
 *   audio-engine/assets/stem-energetic.wav
 *   audio-engine/assets/stem-tense.wav
 *
 * If FAL_KEY is not available, use:
 *   npm run prepare-stems   (derives EQ variants from bed.wav, no account needed)
 */

import "dotenv/config";
import { fal } from "@fal-ai/client";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(__dirname, "..", "assets");

const DURATION_SECONDS = 60;

/** Distinct musical prompts for each mood category. */
const STEMS = [
  {
    mood: "calm",
    outputPath: path.join(ASSETS, "stem-calm.wav"),
    prompt:
      "Slow, minimal ambient instrumental loop. Sparse sparse piano chords, " +
      "soft sustained pads, gentle reverb, very little rhythmic movement. " +
      "Meditative, introspective atmosphere. No drums, no percussion, no fills. " +
      "Key: A minor, Tempo: 96 BPM. Must loop seamlessly.",
  },
  {
    mood: "energetic",
    outputPath: path.join(ASSETS, "stem-energetic.wav"),
    prompt:
      "Warm, minimal instrumental loop bed for a live performance demo. " +
      "Steady four-on-the-floor pulse, soft analog pads, gentle plucked synth arpeggio, " +
      "no vocals, no drum fills or breaks, consistent energy throughout so it loops seamlessly. " +
      "Key: A minor, Tempo: 96 BPM.",
  },
  {
    mood: "tense",
    outputPath: path.join(ASSETS, "stem-tense.wav"),
    prompt:
      "Intense, dark cinematic instrumental loop. Driving rhythmic tension, " +
      "dissonant string ostinato, unsettled chromatic bass movement, " +
      "building pressure without resolving. Urgent and dramatic. " +
      "No vocals. Key: A minor, Tempo: 96 BPM. Must loop seamlessly.",
  },
];

async function generateStem({ mood, prompt, outputPath }) {
  console.log(`\n[generate-stems] requesting stem: ${mood}`);
  console.log(`[generate-stems]   prompt: ${prompt.slice(0, 80)}...`);

  const result = await fal.subscribe("CassetteAI/music-generator", {
    input: { prompt, duration: DURATION_SECONDS },
    logs: true,
    onQueueUpdate: (update) => {
      if (update.status === "IN_PROGRESS") {
        update.logs.map((l) => l.message).forEach((m) => console.log(`  [fal] ${m}`));
      }
    },
  });

  const audioUrl = result?.data?.audio_file?.url;
  if (!audioUrl) {
    throw new Error(`Unexpected fal.ai response for ${mood}: ${JSON.stringify(result)}`);
  }

  console.log(`[generate-stems] downloading ${mood} stem from ${audioUrl}`);
  const response = await fetch(audioUrl);
  if (!response.ok) {
    throw new Error(`Download failed for ${mood}: ${response.status} ${response.statusText}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(outputPath, buffer);
  console.log(`[generate-stems] saved ${mood} → ${outputPath} (${buffer.length} bytes)`);
}

async function main() {
  if (!process.env.FAL_KEY) {
    throw new Error(
      "FAL_KEY is not set.\n" +
      "Copy audio-engine/.env.example to .env and add your fal.ai key,\n" +
      "or run: FAL_KEY=xxx npm run generate-stems\n\n" +
      "No fal.ai account? Use npm run prepare-stems for offline EQ variants."
    );
  }

  console.log("[generate-stems] generating 3 mood stems via CassetteAI/music-generator");
  console.log("[generate-stems] this will take a few minutes per stem...");

  for (const stem of STEMS) {
    await generateStem(stem);
  }

  console.log("\n[generate-stems] done. Commit all three stems to the repo before the demo.");
}

main().catch((err) => {
  console.error("[generate-stems] failed:", err.message);
  process.exitCode = 1;
});
