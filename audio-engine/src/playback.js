import { AudioContext } from "node-web-audio-api";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CUTOFF_HZ, DEFAULT_TREMOLO_HZ } from "./pencil-mapper.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BED_PATH = path.join(__dirname, "..", "assets", "bed.wav");

// Tremolo (Epic 6) is a periodic gain modulation: an LFO oscillator feeds a
// depth-scaling gain node into the output gain's AudioParam, which Web Audio
// sums with the param's base value. Base/depth are fixed structural
// constants (not part of the pencil->param mapping), so they live here
// rather than in pencil-mapper.js.
const TREMOLO_BASE_GAIN = 0.85;
const TREMOLO_DEPTH = 0.15; // gain oscillates in [BASE-DEPTH, BASE+DEPTH] = [0.7, 1.0]

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
 *
 * Epic 6 addition: a melody/timbre chain sits between `sourceNode` and
 * `context.destination` — filterNode (lowpass, brightness) -> pannerNode
 * (stereo position) -> tremoloGain (note-density proxy, driven by an LFO).
 * These are separate AudioParams from Epic 3's `sourceNode.playbackRate`
 * (tempo), so the two epics' live inputs never contend for the same knob.
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

  // Epic 6 melody/timbre chain.
  const filterNode = context.createBiquadFilter();
  filterNode.type = "lowpass";
  filterNode.frequency.value = DEFAULT_CUTOFF_HZ;

  const pannerNode = context.createStereoPanner();

  const tremoloGain = context.createGain();
  tremoloGain.gain.value = TREMOLO_BASE_GAIN;

  const lfo = context.createOscillator();
  lfo.type = "sine";
  lfo.frequency.value = DEFAULT_TREMOLO_HZ;
  const lfoDepth = context.createGain();
  lfoDepth.gain.value = TREMOLO_DEPTH;
  lfo.connect(lfoDepth);
  lfoDepth.connect(tremoloGain.gain);

  sourceNode.connect(filterNode);
  filterNode.connect(pannerNode);
  pannerNode.connect(tremoloGain);
  tremoloGain.connect(context.destination);

  sourceNode.start();
  lfo.start();

  console.log(`[playback] looping ${BED_PATH} (${audioBuffer.duration.toFixed(1)}s bed)`);

  return { context, sourceNode, filterNode, pannerNode, tremoloGain, lfo };
}
