import { AudioContext } from "node-web-audio-api";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BED_PATH = path.join(__dirname, "..", "assets", "bed.wav");

/**
 * Loads the committed fal.ai bed (audio-engine/assets/bed.wav) and loops it
 * continuously through the system audio output via node-web-audio-api,
 * a native (non-browser) Web Audio API implementation for Node.
 *
 * Deviation from the original Tone.js plan: Tone.js was tried first, but its
 * internal type-checks (via the `standardized-audio-context` package) only
 * recognize that package's own AudioParam/AudioNode classes, not
 * node-web-audio-api's native ones — so `new Tone.Player(...)` throws
 * "param must be an AudioParam" even though node-web-audio-api is a
 * spec-compliant implementation. Rather than fight that interop, this uses
 * node-web-audio-api's native nodes directly — plain Web Audio API, no
 * Tone.js layer. See docs/epic-2-audio-engine-scaffold.md for details.
 *
 * Epic 3/6 hook point: node-web-audio-api's AudioContext already exposes the
 * full native node set (BiquadFilterNode, GainNode, playbackRate on the
 * source node, etc.) needed for tempo/filter/melody DSP — build on `context`
 * and `sourceNode` returned here rather than reintroducing Tone.js.
 */
export async function startPlayback() {
  const context = new AudioContext();

  const fileBuffer = await readFile(BED_PATH);
  const arrayBuffer = fileBuffer.buffer.slice(
    fileBuffer.byteOffset,
    fileBuffer.byteOffset + fileBuffer.byteLength
  );
  const audioBuffer = await context.decodeAudioData(arrayBuffer);

  const sourceNode = context.createBufferSource();
  sourceNode.buffer = audioBuffer;
  sourceNode.loop = true;
  sourceNode.connect(context.destination);
  sourceNode.start();

  console.log(`[playback] looping ${BED_PATH} (${audioBuffer.duration.toFixed(1)}s bed)`);

  return { context, sourceNode };
}
