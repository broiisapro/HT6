/**
 * prepare-stems.js — Epic 9: Offline Stem Preparation
 *
 * Derives three mood-stem WAV files from the existing bed.wav by applying
 * distinct EQ processing in an OfflineAudioContext. All stems are at the
 * same native 96 BPM tempo so bpmToPlaybackRate() continues to work
 * correctly on top of whichever stem is active.
 *
 * Usage: node scripts/prepare-stems.js
 *
 * Output (committed to repo):
 *   audio-engine/assets/stem-calm.wav       — dark, mellow (LPF 700 Hz)
 *   audio-engine/assets/stem-energetic.wav  — full-range (copy of bed.wav)
 *   audio-engine/assets/stem-tense.wav      — bright, edgy (highshelf +10 dB at 2 kHz)
 *
 * For genuinely distinct musical compositions, see scripts/generate-stems.js
 * (requires FAL_KEY). This script is the zero-dependency fallback that makes
 * the classification system work immediately without an fal.ai account.
 */

import { AudioContext, OfflineAudioContext } from "node-web-audio-api";
import { readFile, writeFile, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(__dirname, "..", "assets");
const BED_PATH = path.join(ASSETS, "bed.wav");

// ── WAV encoder (16-bit PCM, interleaved) ────────────────────────────────────
function audioBufferToWav(audioBuffer) {
  const numChannels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const numSamples = audioBuffer.length;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = numSamples * blockAlign;
  const buffer = Buffer.allocUnsafe(44 + dataSize);
  let pos = 0;

  const wStr = (s) => { buffer.write(s, pos, "ascii"); pos += s.length; };
  const wU32 = (v) => { buffer.writeUInt32LE(v, pos); pos += 4; };
  const wU16 = (v) => { buffer.writeUInt16LE(v, pos); pos += 2; };

  wStr("RIFF"); wU32(36 + dataSize); wStr("WAVE");
  wStr("fmt "); wU32(16); wU16(1 /* PCM */); wU16(numChannels);
  wU32(sampleRate); wU32(byteRate); wU16(blockAlign); wU16(bitsPerSample);
  wStr("data"); wU32(dataSize);

  const channels = [];
  for (let ch = 0; ch < numChannels; ch++) channels.push(audioBuffer.getChannelData(ch));

  for (let i = 0; i < numSamples; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const s = Math.max(-1, Math.min(1, channels[ch][i]));
      buffer.writeInt16LE(Math.round(s * (s < 0 ? 0x8000 : 0x7fff)), pos);
      pos += 2;
    }
  }
  return buffer;
}

// ── Render a processed stem via OfflineAudioContext ──────────────────────────
async function renderStem(bedBuffer, { type, frequency, gain: gainDb, label }) {
  const { numberOfChannels, sampleRate, duration } = bedBuffer;
  // Render exactly as long as the source bed (preserves loop length)
  const numFrames = Math.round(sampleRate * duration);
  const ctx = new OfflineAudioContext(numberOfChannels, numFrames, sampleRate);

  const source = ctx.createBufferSource();
  source.buffer = bedBuffer;
  source.loop = true;
  source.playbackRate.value = 1.0; // keep 96 BPM native tempo

  let lastNode = source;

  if (type !== null) {
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = frequency;
    if (gainDb !== undefined) filter.gain.value = gainDb;
    filter.Q.value = 0.707; // Butterworth (maximally flat)
    lastNode.connect(filter);
    lastNode = filter;
  }

  lastNode.connect(ctx.destination);
  source.start(0);

  console.log(`  [prepare-stems] rendering ${label}...`);
  const rendered = await ctx.startRendering();
  console.log(`  [prepare-stems] ${label} done (${rendered.duration.toFixed(1)}s, ${rendered.numberOfChannels}ch, ${rendered.sampleRate}Hz)`);
  return rendered;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  if (!existsSync(BED_PATH)) {
    throw new Error(`bed.wav not found at ${BED_PATH}. Run npm run generate-bed first.`);
  }

  console.log("[prepare-stems] loading bed.wav...");
  const raw = await readFile(BED_PATH);
  const arrayBuffer = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);

  // Decode via a short-lived AudioContext (OfflineAudioContext can't decodeAudioData in node-web-audio-api)
  const tmpCtx = new AudioContext();
  const bedBuffer = await tmpCtx.decodeAudioData(arrayBuffer.slice(0));
  await tmpCtx.close();

  console.log(`[prepare-stems] bed: ${bedBuffer.duration.toFixed(1)}s, ${bedBuffer.numberOfChannels}ch, ${bedBuffer.sampleRate}Hz`);
  console.log("[prepare-stems] generating 3 mood stems...\n");

  // ── CALM: lowpass at 700 Hz — dark, muted, mellow ─────────────────────────
  const calmBuffer = await renderStem(bedBuffer, {
    type: "lowpass", frequency: 700, label: "stem-calm (LPF 700Hz — dark/mellow)"
  });
  await writeFile(
    path.join(ASSETS, "stem-calm.wav"),
    audioBufferToWav(calmBuffer)
  );
  console.log("  [prepare-stems] → assets/stem-calm.wav written\n");

  // ── ENERGETIC: full-range — copy of bed.wav, no processing ────────────────
  await copyFile(BED_PATH, path.join(ASSETS, "stem-energetic.wav"));
  console.log("  [prepare-stems] → assets/stem-energetic.wav written (copy of bed.wav)\n");

  // ── TENSE: highshelf at 2 kHz +10 dB — bright, edgy, urgent ──────────────
  const tenseBuffer = await renderStem(bedBuffer, {
    type: "highshelf", frequency: 2000, gain: 10, label: "stem-tense (highshelf +10dB @ 2kHz — bright/edgy)"
  });
  await writeFile(
    path.join(ASSETS, "stem-tense.wav"),
    audioBufferToWav(tenseBuffer)
  );
  console.log("  [prepare-stems] → assets/stem-tense.wav written\n");

  console.log("[prepare-stems] done. Commit all three stems to the repo.");
  console.log("[prepare-stems] For genuinely distinct compositions, run: FAL_KEY=... npm run generate-stems");

  process.exit(0);
}

main().catch((err) => {
  console.error("[prepare-stems] failed:", err);
  process.exitCode = 1;
});
