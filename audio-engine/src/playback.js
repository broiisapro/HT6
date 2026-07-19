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

  // ── Pre-load all zone tracks for instant crossfade on zone switch ────
  // Decode every track upfront; switchBed() crossfades synchronously without
  // waiting for file I/O or decoding.
  const playableZones = await listPlayableZones();
  const startZone = playableZones.includes(initialZone) ? initialZone : (playableZones[0] || DEFAULT_ZONE);
  const allZoneBuffers = new Map(); // zoneName → AudioBuffer[]

  for (const zone of playableZones) {
    const tracks = await listTracks(zone);
    const buffers = await Promise.all(
      tracks.map(async (filePath) => {
        const raw = await readFile(filePath);
        const buf = await context.decodeAudioData(raw.buffer);
        decodedCache.set(filePath, buf);
        return buf;
      })
    );
    allZoneBuffers.set(zone, buffers);
    console.log(`[playback] pre-loaded ${buffers.length} track(s) for zone "${zone}"`);
  }

  // ── Start initial track with a per-source gain node ───────────────────
  // Each source gets its own gain node so outgoing and incoming tracks can
  // overlap during crossfade. switchBed() ramps these gains 0↔1.
  let currentRate     = 1.0;
  let currentZoneName = startZone;

  const initialBufs = allZoneBuffers.get(startZone) ?? [];
  const initialBuffer = pickRandom(initialBufs);

  let activeSource = context.createBufferSource();
  activeSource.buffer = initialBuffer;
  activeSource.loop   = true;
  let activeSourceGain = context.createGain();
  activeSourceGain.gain.value = 1.0;
  activeSource.connect(activeSourceGain);
  activeSourceGain.connect(filterNode);
  activeSource.start();
  console.log(`[playback] starting in zone "${startZone}" (${initialBufs.length} track(s) available)`);

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

  // ── Zone audio profiles ──────────────────────────────────────────────────
  // Extreme values for clearly audible transitions. Pencil overrides these
  // while active; the profile is the baseline the mix returns to on Pencil lift.
  //   calm:      very dark + near-static   → muted, restful
  //   focused:   midrange + steady pulse   → alert, purposeful
  //   dreamy:    very bright + ultra-slow  → spacious, ethereal
  //   energised: fully open + rapid tremolo → vivid, intense
  const ZONE_PROFILES = {
    calm:      { filterHz: 150,   tremoloHz: 0.1 },
    focused:   { filterHz: 2500,  tremoloHz: 1.5 },
    dreamy:    { filterHz: 7000,  tremoloHz: 0.3 },
    energised: { filterHz: 18000, tremoloHz: 8.0 },
  };

  // TC = 0.5s → ~3 TC = 1.5s for a natural crossfade between zone profiles.
  const ZONE_CROSSFADE_TC = 0.5;

  /**
   * Switch to a zone: crossfade the track AND apply the zone's DSP profile.
   * Called by server.js on zone changes in both static and dynamic mode.
   * @param {string} zoneName - One of the four zone names.
   */
  function switchBed(zoneName) {
    const profile = ZONE_PROFILES[zoneName];
    if (!profile) {
      console.warn(`[playback] switchBed: unknown zone "${zoneName}" — ignored`);
      return;
    }
    const now = context.currentTime;

    // 1. Apply zone DSP profile (filter brightness + tremolo rate).
    filterNode.frequency.setTargetAtTime(profile.filterHz, now, ZONE_CROSSFADE_TC);
    lfo.frequency.setTargetAtTime(profile.tremoloHz, now, ZONE_CROSSFADE_TC);
    currentZoneName = zoneName;

    // 2. Crossfade to a random track from the new zone's folder.
    const zoneBufs = allZoneBuffers.get(zoneName);
    if (!zoneBufs || zoneBufs.length === 0) {
      console.warn(`[playback] switchBed: no tracks for zone "${zoneName}" — DSP profile applied, track unchanged`);
      return;
    }
    const newBuffer = pickRandom(zoneBufs);

    const newSrc = context.createBufferSource();
    newSrc.buffer = newBuffer;
    newSrc.loop   = true;
    newSrc.playbackRate.value = currentRate; // inherit active tempo nudge

    const newGain = context.createGain();
    newGain.gain.value = 0; // start silent
    newSrc.connect(newGain);
    newGain.connect(filterNode);
    newSrc.start();

    // Ramp new source in, old source out over CROSSFADE_SEC.
    const TC = CROSSFADE_SEC / 3; // 3 TCs → ~95% settled
    newGain.gain.setTargetAtTime(1.0, now, TC);
    if (activeSourceGain) activeSourceGain.gain.setTargetAtTime(0, now, TC);

    const oldSrc  = activeSource;
    const oldGain = activeSourceGain;
    activeSource      = newSrc;
    activeSourceGain  = newGain;

    // Disconnect old source after crossfade settles (~5 TCs).
    setTimeout(() => {
      try { if (oldSrc)  { oldSrc.stop(); oldSrc.disconnect(); }  } catch (_) {}
      try { if (oldGain) oldGain.disconnect(); } catch (_) {}
    }, Math.ceil(CROSSFADE_SEC * 5 * 1000));

    console.log(`[playback] zone → ${zoneName} (filter=${profile.filterHz}Hz tremolo=${profile.tremoloHz}Hz) + track crossfade`);
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

  /**
   * Set the playback rate on the currently active source node.
   * Use this instead of accessing sourceNode.playbackRate directly —
   * the active source changes on every zone/track switch.
   * @param {number} rate
   */
  function setPlaybackRate(rate) {
    currentRate = rate;
    if (activeSource) activeSource.playbackRate.value = rate;
  }

  /** Return the current zone's DSP profile, or null if zone is unknown. */
  function getCurrentZoneProfile() {
    return ZONE_PROFILES[currentZoneName] ?? null;
  }

  return { setPlaybackRate, getCurrentZoneProfile, filterNode, pannerNode, tremoloGain, lfo, playBeat, applyStressIntensity, playPluck, switchBed };
}

export { DEFAULT_ZONE };
