import { AudioContext } from "node-web-audio-api";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CUTOFF_HZ, DEFAULT_TREMOLO_HZ, DEFAULT_PAN } from "./pencil-mapper.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.join(__dirname, "..", "assets");
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".ogg"]);
const DEFAULT_ZONE = "calm";

/** Crossfade duration (seconds) when switching zones. */
const CROSSFADE_SEC = 0.6;

/** Tremolo (Epic 6) gain-modulation constants — see playback.js on main for origin. */
const TREMOLO_BASE_GAIN = 0.85;
const TREMOLO_DEPTH = 0.15; // gain oscillates in [BASE-DEPTH, BASE+DEPTH] = [0.7, 1.0]

/**
 * Zones are whatever subdirectories exist under assets/ — not hardcoded.
 * Drop more tracks into an existing zone's folder (e.g. assets/calm/) and
 * they join that zone's random pool automatically; add a new zone folder
 * (e.g. assets/epic/) and it becomes selectable with no code change.
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
 * Loads mood-zone tracks (audio-engine/assets/<zone>/*) and loops a
 * randomly-picked track from the current zone through a persistent
 * filter -> pan -> tremolo effects chain to the system audio output, via
 * node-web-audio-api (a native, non-browser Web Audio API implementation —
 * see docs/epic-2-audio-engine-scaffold.md for why Tone.js was dropped).
 *
 * ── Persistent effects chain ────────────────────────────────────────────
 * filterNode (lowpass, brightness) -> pannerNode (stereo position) ->
 * tremoloGain (note-density proxy, driven by an LFO) -> destination. These
 * three nodes are created once and never torn down — Epic 6's
 * pencil-mapper.js output targets them directly via setMelodyParams(), and
 * they keep working unchanged across zone switches, since switchBed() only
 * ever replaces what feeds *into* the front of this chain.
 *
 * ── Zone switching + crossfade ──────────────────────────────────────────
 * Each zone's source gets its own per-source gain node (not shared) so an
 * outgoing and incoming track can overlap briefly: switchBed() ramps the
 * new source's gain 0->1 and the old one's 1->0 over CROSSFADE_SEC, then
 * stops/disconnects the old source once the fade completes. This avoids
 * the hard stop/start cut of the original single-zone version.
 *
 * ── Tempo ────────────────────────────────────────────────────────────────
 * setTempo(rate) applies playbackRate to whichever source is currently the
 * active (post-crossfade) one — callers don't need to track node identity
 * across zone switches.
 *
 * Epic 3 hook point: biometric-zone-mapper.js's createZoneTracker()/
 * bpmToPlaybackRateWithinZone() decide *which* zone and *what* rate; call
 * switchBed(zone) and setTempo(rate) from server.js's message handler.
 * Epic 6 hook point: pencil-mapper.js's pencilToAudioParams() decides
 * cutoff/tremolo/pan; call setMelodyParams({cutoffHz, tremoloHz, pan}) from
 * the same handler.
 */
export async function startPlayback(initialZone) {
  const context = new AudioContext();
  const decodedCache = new Map(); // filePath -> AudioBuffer, avoids re-decoding on repeat picks

  // ── Persistent effects chain (survives zone switches) ──────────────────
  const filterNode = context.createBiquadFilter();
  filterNode.type = "lowpass";
  filterNode.frequency.value = DEFAULT_CUTOFF_HZ;

  const pannerNode = context.createStereoPanner();
  pannerNode.pan.value = DEFAULT_PAN;

  const tremoloGain = context.createGain();
  tremoloGain.gain.value = TREMOLO_BASE_GAIN;

  const lfo = context.createOscillator();
  lfo.type = "sine";
  lfo.frequency.value = DEFAULT_TREMOLO_HZ;
  const lfoDepth = context.createGain();
  lfoDepth.gain.value = TREMOLO_DEPTH;
  lfo.connect(lfoDepth);
  lfoDepth.connect(tremoloGain.gain);

  filterNode.connect(pannerNode);
  pannerNode.connect(tremoloGain);
  tremoloGain.connect(context.destination);
  lfo.start();

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

  let activeSource = null; // { sourceNode, gainNode }

  async function switchBed(zone) {
    const tracks = await listTracks(zone);
    if (tracks.length === 0) {
      throw new Error(`No tracks found for zone "${zone}" (assets/${zone}/)`);
    }
    const filePath = pickRandom(tracks);
    const audioBuffer = await getDecodedBuffer(filePath);
    const now = context.currentTime;

    const sourceNode = context.createBufferSource();
    sourceNode.buffer = audioBuffer;
    sourceNode.loop = true;
    const gainNode = context.createGain();
    gainNode.gain.setValueAtTime(0, now);
    gainNode.gain.linearRampToValueAtTime(1, now + CROSSFADE_SEC);
    sourceNode.connect(gainNode);
    gainNode.connect(filterNode);
    sourceNode.start();

    const outgoing = activeSource;
    if (outgoing) {
      outgoing.gainNode.gain.setValueAtTime(outgoing.gainNode.gain.value, now);
      outgoing.gainNode.gain.linearRampToValueAtTime(0, now + CROSSFADE_SEC);
      setTimeout(() => {
        outgoing.sourceNode.stop();
        outgoing.sourceNode.disconnect();
        outgoing.gainNode.disconnect();
      }, CROSSFADE_SEC * 1000 + 50);
    }

    activeSource = { sourceNode, gainNode };

    console.log(
      `[playback] zone "${zone}": looping ${path.basename(filePath)} (${audioBuffer.duration.toFixed(1)}s, picked from ${tracks.length} track(s))`
    );
  }

  /** Apply a playbackRate to whichever source is currently active. */
  function setTempo(rate) {
    if (activeSource) activeSource.sourceNode.playbackRate.value = rate;
  }

  /**
   * Apply pencil-derived melody/timbre params to the persistent effects
   * chain. Uses setTargetAtTime (not a direct .value jump) to avoid audible
   * zipper noise at pencil's ~30 msg/s rate.
   */
  function setMelodyParams({ cutoffHz, tremoloHz, pan }) {
    const now = context.currentTime;
    filterNode.frequency.setTargetAtTime(cutoffHz, now, 0.05);
    lfo.frequency.setTargetAtTime(tremoloHz, now, 0.05);
    pannerNode.pan.setTargetAtTime(pan, now, 0.05);
  }

  /** Revert melody/timbre params to their idle defaults (pencil stale-data fallback). */
  function revertMelodyDefaults() {
    const now = context.currentTime;
    filterNode.frequency.setTargetAtTime(DEFAULT_CUTOFF_HZ, now, 0.05);
    lfo.frequency.setTargetAtTime(DEFAULT_TREMOLO_HZ, now, 0.05);
    pannerNode.pan.setTargetAtTime(DEFAULT_PAN, now, 0.05);
  }

  const playableZones = await listPlayableZones();
  if (playableZones.length === 0) {
    throw new Error("No zone has any tracks yet. Add audio files under assets/<zone>/.");
  }
  const startZone = initialZone ?? (playableZones.includes(DEFAULT_ZONE) ? DEFAULT_ZONE : playableZones[0]);
  await switchBed(startZone);

  return { context, zone: startZone, switchBed, setTempo, setMelodyParams, revertMelodyDefaults };
}

export { DEFAULT_ZONE };
