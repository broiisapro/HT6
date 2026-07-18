import { AudioContext } from "node-web-audio-api";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.join(__dirname, "..", "assets");
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".ogg"]);
const DEFAULT_ZONE = "calm";

/**
 * Zones are whatever subdirectories exist under assets/ — not hardcoded.
 * Drop more tracks into an existing zone's folder (e.g. assets/calm/) and
 * they join that zone's random pool automatically; add a new zone folder
 * (e.g. assets/pumped/) and it becomes selectable with no code change.
 */
export async function listZones() {
  const entries = await readdir(ASSETS_DIR, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

export async function listTracks(zone) {
  const zoneDir = path.join(ASSETS_DIR, zone);
  const entries = await readdir(zoneDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && AUDIO_EXTENSIONS.has(path.extname(e.name).toLowerCase()))
    .map((e) => path.join(zoneDir, e.name));
}

/** Zones that currently have at least one track — the only ones startable/selectable right now. */
export async function listPlayableZones() {
  const zones = await listZones();
  const results = await Promise.all(zones.map(async (zone) => ((await listTracks(zone)).length > 0 ? zone : null)));
  return results.filter((zone) => zone !== null);
}

function pickRandom(list) {
  return list[Math.floor(Math.random() * list.length)];
}

/**
 * Loads and loops a randomly-picked track from the current zone's folder
 * through the system audio output, via node-web-audio-api (a native,
 * non-browser Web Audio API implementation — see
 * docs/epic-2-audio-engine-scaffold.md for why Tone.js was dropped).
 *
 * Epic 3 hook point: this epic only prepares the assets and the mechanism to
 * switch between zones (`switchBed`) — it does not decide bpm-to-zone
 * thresholds or call `switchBed` from live biometric messages. Epic 3 should
 * map incoming `{type: "biometric", bpm}` to a zone name (from `listZones()`)
 * and call `switchBed(zone)` from the WS message handler in server.js.
 * Epic 6 hook point: `context` exposes the full native node set
 * (BiquadFilterNode, GainNode, etc.) for melody/timbre DSP layered on top of
 * whichever track is currently playing.
 */
export async function startPlayback(initialZone) {
  const context = new AudioContext();
  const decodedCache = new Map(); // filePath -> AudioBuffer, avoids re-decoding on repeat picks

  async function getDecodedBuffer(filePath) {
    if (!decodedCache.has(filePath)) {
      const fileBuffer = await readFile(filePath);
      const arrayBuffer = fileBuffer.buffer.slice(
        fileBuffer.byteOffset,
        fileBuffer.byteOffset + fileBuffer.byteLength
      );
      decodedCache.set(filePath, await context.decodeAudioData(arrayBuffer));
    }
    return decodedCache.get(filePath);
  }

  let sourceNode = null;

  async function switchBed(zone) {
    const tracks = await listTracks(zone);
    if (tracks.length === 0) {
      throw new Error(`No tracks found for zone "${zone}" (assets/${zone}/)`);
    }
    const filePath = pickRandom(tracks);
    const audioBuffer = await getDecodedBuffer(filePath);

    if (sourceNode) {
      sourceNode.stop();
      sourceNode.disconnect();
    }
    sourceNode = context.createBufferSource();
    sourceNode.buffer = audioBuffer;
    sourceNode.loop = true;
    sourceNode.connect(context.destination);
    sourceNode.start();

    console.log(
      `[playback] zone "${zone}": looping ${path.basename(filePath)} (${audioBuffer.duration.toFixed(1)}s, picked from ${tracks.length} track(s))`
    );
  }

  const playableZones = await listPlayableZones();
  if (playableZones.length === 0) {
    throw new Error("No zone has any tracks yet. Add audio files under assets/<zone>/.");
  }
  const startZone = initialZone ?? (playableZones.includes(DEFAULT_ZONE) ? DEFAULT_ZONE : playableZones[0]);
  await switchBed(startZone);

  return { context, switchBed };
}

export { DEFAULT_ZONE };
