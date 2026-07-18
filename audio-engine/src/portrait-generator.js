/**
 * portrait-generator.js — Epic 9.5: Performance Portrait
 *
 * Fires one fal.ai image-generation call seeded by the session's real data
 * after the performance ends. Called manually by the performer pressing 'r'
 * in the audio-engine terminal.
 *
 * ── Model choice: fal-ai/flux/schnell ────────────────────────────────────────
 * FLUX.1 Schnell generates 1024×768 images in ~2–4 s on the fal.ai queue
 * (vs. SDXL at ~10–20 s). Speed matters for post-performance portraits:
 * the audience's attention is still on the stage; a multi-minute wait kills
 * the moment. Schnell's quality is more than sufficient for a projected
 * audience-facing image. FLUX.1 Dev was also considered but the queue time
 * is higher and the quality delta is not visible at presentation scale.
 *
 * ── Fallback ─────────────────────────────────────────────────────────────────
 * portrait-fallback.svg is a pre-committed placeholder image served if:
 *   - FAL_KEY is not set
 *   - The fal.ai call fails or takes > FALLBACK_SHOW_AFTER_MS to respond
 * The fallback is shown immediately; the generated portrait replaces it
 * when (if) it arrives. The path to the active portrait is printed so the
 * operator can open it immediately.
 */

import "dotenv/config";
import { fal }      from "@fal-ai/client";
import { writeFile } from "node:fs/promises";
import path          from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS    = path.join(__dirname, "..", "assets");

export const PORTRAIT_OUTPUT_PATH   = path.join(ASSETS, "portrait-latest.png");
export const PORTRAIT_FALLBACK_PATH = path.join(ASSETS, "portrait-fallback.svg");

/** Log a fallback notice; real generate happens in the background. */
const FALLBACK_SHOW_AFTER_MS = 8000;

const MOOD_PALETTE = {
  calm:      "deep navy blue, midnight teal, soft indigo, muted silver",
  energetic: "vibrant jade green, warm amber, electric cyan, golden yellow",
  tense:     "crimson red, hot orange, stark white highlights, dark charcoal",
};

/**
 * Build the fal.ai image prompt from session data.
 *
 * @param {import('./session-tracker.js').SessionData} data
 * @returns {string}
 */
function buildPrompt(data) {
  const dominant = Object.entries(data.moodPercent)
    .sort((a, b) => b[1] - a[1])[0][0];
  const palette  = MOOD_PALETTE[dominant];

  const moodSummary =
    `calm ${data.moodPercent.calm}%, energetic ${data.moodPercent.energetic}%, ` +
    `tense ${data.moodPercent.tense}%`;

  return (
    `Abstract generative art portrait of a live biometric music performance. ` +
    `Heart rate arc: ${data.bpmMin}–${data.bpmMax} BPM. ` +
    `Dominant mood: ${dominant} (${moodSummary}). ` +
    `${data.strokeCount} pencil gestures at avg ${data.avgVelocityPxs} px/s velocity. ` +
    (data.panicCount > 0 ? `${data.panicCount} panic-mode spike(s). ` : "") +
    `Color palette: ${palette}. ` +
    `Style: flowing biometric data visualization, generative art, data portrait, ` +
    `elegant digital art, glowing abstract shapes, cinematic composition, highly detailed.`
  );
}

/**
 * Generate a post-performance portrait from session data.
 * Fires fal.ai FLUX.1 Schnell in the background — returns immediately.
 * Prints the fallback path immediately and the generated image path when done.
 *
 * Safe to call from a keypress handler; fully async, no await needed.
 *
 * @param {import('./session-tracker.js').SessionData} data
 */
export function generatePortrait(data) {
  // Always announce the fallback immediately so the operator has something to show.
  console.log(`\n[portrait] Fallback portrait: ${PORTRAIT_FALLBACK_PATH}`);
  console.log("[portrait] Generating fal.ai portrait in background...");
  console.log("[portrait] Session data:", JSON.stringify(data, null, 2));

  if (!process.env.FAL_KEY) {
    console.warn(
      "[portrait] FAL_KEY not set — skipping fal.ai call. " +
      "Add FAL_KEY to audio-engine/.env to enable portrait generation. " +
      `Showing fallback: ${PORTRAIT_FALLBACK_PATH}`
    );
    return;
  }

  const prompt = buildPrompt(data);
  console.log(`[portrait] Prompt: ${prompt}`);

  // Fire and forget — no await, no blocking.
  _generateAsync(prompt).catch((err) => {
    console.error("[portrait] Generation failed:", err.message);
    console.log(`[portrait] Fallback portrait still available at: ${PORTRAIT_FALLBACK_PATH}`);
  });
}

async function _generateAsync(prompt) {
  const result = await fal.subscribe("fal-ai/flux/schnell", {
    input: {
      prompt,
      image_size:       "landscape_4_3",  // 1280×960, good for a projector
      num_inference_steps: 4,             // Schnell default — fast
      num_images:       1,
    },
    logs: false,
  });

  const imageUrl = result?.data?.images?.[0]?.url;
  if (!imageUrl) {
    throw new Error(`Unexpected fal.ai response shape: ${JSON.stringify(result?.data)}`);
  }

  const response = await fetch(imageUrl);
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }

  const buf = Buffer.from(await response.arrayBuffer());
  await writeFile(PORTRAIT_OUTPUT_PATH, buf);
  console.log(`\n[portrait] ✓ Portrait saved: ${PORTRAIT_OUTPUT_PATH} (${buf.length} bytes)`);
  console.log("[portrait]   Open that file to display the generated portrait.");
}
