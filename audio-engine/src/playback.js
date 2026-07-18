import { AudioContext } from "node-web-audio-api";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CUTOFF_HZ, DEFAULT_TREMOLO_HZ } from "./pencil-mapper.js";

/** Thump synth constants (Item 3 — beat events). */
const THUMP_FREQ_HZ     = 60;   // fundamental: low sine rumble
const THUMP_ATTACK_S    = 0.002; // 2ms attack
const THUMP_DECAY_S     = 0.2;   // 200ms exponential decay

/** Pluck synth constants (Item 5 — pencil melody voice). */
const PLUCK_ATTACK_S   = 0.005;  // 5ms attack
const PLUCK_DECAY_S    = 0.6;    // 600ms exponential decay (mid of 400–800ms)
const PLUCK_GAIN       = 0.4;    // peak gain

/** Stress layer constants (Item 4 — stress-spike triggered chain). */
const STRESS_BP_LOW_HZ  = 200;   // bandpass centre at intensity=0
const STRESS_BP_HIGH_HZ = 4000;  // bandpass centre at intensity=1
const STRESS_BED_DUCK   = 0.6;   // main-bed gain dip on PEAK entry
const STRESS_DUCK_TC    = 0.04;  // setTargetAtTime TC for duck (150ms dip)
const STRESS_RECOVER_TC = 0.3;   // setTargetAtTime TC for duck recovery

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
export async function startPlayback(initialZone) {
  const context = new AudioContext();
  const decodedCache = new Map(); // filePath -> AudioBuffer, avoids re-decoding on repeat picks

  // ── Persistent effects chain (survives zone switches) ──────────────────
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

  filterNode.connect(pannerNode);
  pannerNode.connect(tremoloGain);
  tremoloGain.connect(context.destination);
  lfo.start();

  // ── Load initial track ───────────────────────────────────────────────
  const zones = await listZones();
  const startZone = zones.includes(initialZone) ? initialZone : (zones[0] || DEFAULT_ZONE);
  const tracks = await listTracks(startZone);
  const trackPath = pickRandom(tracks);
  const arrayBuffer = await readFile(trackPath);
  const audioBuffer = await context.decodeAudioData(arrayBuffer.buffer);

  const sourceNode = context.createBufferSource();
  sourceNode.buffer = audioBuffer;
  sourceNode.loop = true;
  sourceNode.connect(filterNode);
  sourceNode.start();
  console.log(`[playback] loaded and looping "${path.basename(trackPath)}" (${audioBuffer.duration.toFixed(1)}s) in "${startZone}" zone`);

  // ── Item 4: Stress layer ──────────────────────────────────────────────────
  // White noise → bandpass filter → gain node driven by intensity01.
  // Self-contained parallel chain, no interaction with the bed chain.
  const NOISE_BUFFER_SIZE = context.sampleRate * 2; // 2 seconds of noise
  const noiseBuffer = context.createBuffer(1, NOISE_BUFFER_SIZE, context.sampleRate);
  const noiseData = noiseBuffer.getChannelData(0);
  for (let i = 0; i < NOISE_BUFFER_SIZE; i++) noiseData[i] = Math.random() * 2 - 1;

  const noiseSource = context.createBufferSource();
  noiseSource.buffer = noiseBuffer;
  noiseSource.loop = true;

  const stressBandpass = context.createBiquadFilter();
  stressBandpass.type = "bandpass";
  stressBandpass.frequency.value = STRESS_BP_LOW_HZ;
  stressBandpass.Q.value = 1.5;

  const stressGain = context.createGain();
  stressGain.gain.value = 0; // silent until triggered

  noiseSource.connect(stressBandpass);
  stressBandpass.connect(stressGain);
  stressGain.connect(context.destination);
  noiseSource.start();

  /**
   * Apply stress intensity to the triggered layer.
   * Called by server.js on every biometric message.
   * @param {number} intensity01  - 0..1, output of createStressStateMachine().update().
   * @param {boolean} isPeakEntry - true on the first call after entering PEAK state.
   */
  function applyStressIntensity(intensity01, isPeakEntry = false) {
    const now = context.currentTime;
    // Sweep bandpass centre: STRESS_BP_LOW at 0, STRESS_BP_HIGH at 1.
    const bpFreq = STRESS_BP_LOW_HZ * Math.pow(STRESS_BP_HIGH_HZ / STRESS_BP_LOW_HZ, intensity01);
    stressBandpass.frequency.setTargetAtTime(bpFreq, now, 0.05);
    stressGain.gain.setTargetAtTime(intensity01, now, 0.05);

    // Optional sidechain-style bed duck on PEAK entry.
    if (isPeakEntry) {
      tremoloGain.gain.setTargetAtTime(STRESS_BED_DUCK, now, STRESS_DUCK_TC);
      tremoloGain.gain.setTargetAtTime(TREMOLO_BASE_GAIN, now + 0.15, STRESS_RECOVER_TC);
    }
  }

  // ── Epic 9: zone audio profiles ─────────────────────────────────────────
  // Each zone has a distinct audio character expressed via filter cutoff and
  // tremolo rate. switchBed() crossfades between profiles smoothly.
  //
  // Profile values chosen for audible differentiation:
  //   calm      — dark (400 Hz lowpass) + slow tremolo (0.4 Hz) → muted, restful
  //   focused   — mid-bright (2000 Hz) + moderate tremolo (1.0 Hz) → alert, steady
  //   dreamy    — bright (4500 Hz) + flowing tremolo (2.5 Hz) → spacious, floating
  //   energised — very bright (8000 Hz) + fast tremolo (5.0 Hz) → vivid, excited
  //
  // Note: pencil-mapper.js also drives filterNode.frequency and lfo.frequency.
  // Pencil input (arriving at ~30 msg/s) overrides zone values in practice —
  // the zone profile is the ambient baseline that pencil modulates on top of.
  // This is acceptable for the hackathon demo scope.
  const ZONE_PROFILES = {
    calm:      { filterHz: 400,  tremoloHz: 0.4 },
    focused:   { filterHz: 2000, tremoloHz: 1.0 },
    dreamy:    { filterHz: 4500, tremoloHz: 2.5 },
    energised: { filterHz: 8000, tremoloHz: 5.0 },
  };

  // TC = 0.5s → ~3 TC = 1.5s for a natural crossfade between zone profiles.
  const ZONE_CROSSFADE_TC = 0.5;

  /**
   * Crossfade audio parameters to match the given zone's profile.
   * Called by server.js on every confirmed zone switch (dynamic mode only).
   * No-op in static mode — zone is pinned, no profile switch needed.
   * @param {string} zoneName - One of the four zone names.
   */
  function switchBed(zoneName) {
    const profile = ZONE_PROFILES[zoneName];
    if (!profile) {
      console.warn(`[playback] switchBed: unknown zone "${zoneName}" — ignored`);
      return;
    }
    const now = context.currentTime;
    filterNode.frequency.setTargetAtTime(profile.filterHz, now, ZONE_CROSSFADE_TC);
    lfo.frequency.setTargetAtTime(profile.tremoloHz, now, ZONE_CROSSFADE_TC);
    console.log(`[playback] zone → ${zoneName} (filter=${profile.filterHz}Hz tremolo=${profile.tremoloHz}Hz)`);
  }

  /**
   * Fire one low-sine thump for a detected heartbeat.
   * Web Audio oscillators are single-use — create a fresh one each call.
   * @param {number} [peakGain=0.5] - 0..1 volume of the thump.
   */
  function playBeat(peakGain = 0.5) {
    const now = context.currentTime;
    const osc  = context.createOscillator();
    const gain = context.createGain();

    osc.type = "sine";
    osc.frequency.value = THUMP_FREQ_HZ;

    // Linear ramp up over THUMP_ATTACK_S, then exponential decay to near-zero.
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(peakGain, now + THUMP_ATTACK_S);
    gain.gain.setTargetAtTime(0.0001, now + THUMP_ATTACK_S, THUMP_DECAY_S / 3);

    osc.connect(gain);
    gain.connect(context.destination);

    osc.start(now);
    // Auto-stop well after decay completes to free resources.
    osc.stop(now + THUMP_ATTACK_S + THUMP_DECAY_S * 4);
  }

  // ── Item 5: monophonic pluck voice state ─────────────────────────────────
  // Single active oscillator+gain pair; replaced on each retrigger.
  let _pluckOsc  = null;
  let _pluckGain = null;

  /**
   * Trigger (or retrigger) the monophonic pluck voice at `freqHz`.
   * Silences the previous note's oscillator immediately — the natural
   * PLUCK_DECAY_S decay still plays through on the gain envelope, but we
   * don’t let the oscillator keep running at the old frequency.
   * @param {number} freqHz - Note frequency (Hz).
   */
  function playPluck(freqHz) {
    const now = context.currentTime;

    // Stop previous oscillator cleanly (doesn't cut the envelope — gain
    // handles the fade; stopping the osc removes the old pitch immediately).
    if (_pluckOsc) {
      try { _pluckOsc.stop(now); } catch (_) {}
      _pluckOsc = null;
    }
    if (_pluckGain) {
      // Cancel scheduled values and ramp out quickly to avoid clicks.
      _pluckGain.gain.cancelScheduledValues(now);
      _pluckGain.gain.setTargetAtTime(0, now, 0.01);
    }

    // Create fresh oscillator + envelope gain (single-use oscillators).
    const osc  = context.createOscillator();
    const gain = context.createGain();

    osc.type = "triangle";
    osc.frequency.value = freqHz;

    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(PLUCK_GAIN, now + PLUCK_ATTACK_S);
    gain.gain.setTargetAtTime(0.0001, now + PLUCK_ATTACK_S, PLUCK_DECAY_S / 3);

    osc.connect(gain);
    gain.connect(context.destination);

    osc.start(now);
    osc.stop(now + PLUCK_ATTACK_S + PLUCK_DECAY_S * 5);

    _pluckOsc  = osc;
    _pluckGain = gain;
  }

  return { context, sourceNode, filterNode, pannerNode, tremoloGain, lfo, playBeat, applyStressIntensity, playPluck, switchBed };
}

export { DEFAULT_ZONE };
