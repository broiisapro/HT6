import { emitKeypressEvents } from "node:readline";
import { startServer } from "./server.js";
import { startPlayback } from "./playback.js";
import { FallbackPlayer } from "./fallback-player.js";
import { MoodClassifier } from "./mood-classifier.js";
import { SessionTracker } from "./session-tracker.js";
import { generatePortrait, PORTRAIT_FALLBACK_PATH } from "./portrait-generator.js";
import { MOOD_INVERSE } from "./mood-classifier.js";
import { MAX_CUTOFF_HZ, DEFAULT_TREMOLO_HZ } from "./pencil-mapper.js";

async function main() {
  // Epic 9: startPlayback() now loads all 3 mood stems and returns
  // setPlaybackRate / crossfadeTo / getActiveMood instead of a bare sourceNode.
  // It fails fast if any stem file is missing.
  const {
    context, filterNode, pannerNode, lfo,
    setPlaybackRate, crossfadeTo, getActiveMood,
  } = await startPlayback();

  // Epic 9: stateful mood classifier with hysteresis.
  const classifier = new MoodClassifier();

  // Epic 8.5: mutable state object for runtime toggles.
  const liveState = {
    staticMode:   false,   // s: freeze all parameters in place
    oppositeMood: false,   // m: invert mood selection (CALM↔TENSE)
    panicMode:    false,   // p: dramatic intensity override (Epic 9.5)
  };

  // Epic 9.5: session tracker for portrait generation.
  const sessionTracker = new SessionTracker();

  // Epic 8: fallback player — uses setPlaybackRate instead of sourceNode.
  const fallbackPlayer = new FallbackPlayer({ setPlaybackRate, filterNode, pannerNode, lfo });

  startServer({
    setPlaybackRate,
    crossfadeTo,
    classifier,
    filterNode,
    pannerNode,
    lfo,
    fallbackPlayer,
    liveState,
    sessionTracker,
  });

  // ── Keypress handler ──────────────────────────────────────────────────────────
  //  f  → toggle fallback playback on/off  (Epic 8)
  //  s  → toggle static mode on/off        (Epic 8.5)
  //  m  → toggle opposite-mood on/off      (Epic 8.5)
  //  p  → toggle panic mode               (Epic 9.5)
  //  r  → render performance portrait     (Epic 9.5)
  //  Ctrl+C → clean exit

  // Epic 9.5 panic-mode constants:
  // Forces TENSE stem + rate 1.3 (~125 BPM) + max brightness/tremolo.
  // 1.3 chosen: clearly audible as a dramatic spike at a 2-min demo
  // without pitch-shifting so far that the key feels wrong (~3 semitones up).
  const PANIC_RATE        = 1.30;
  const PANIC_FILTER_HZ   = MAX_CUTOFF_HZ;   // full brightness
  const PANIC_TREMOLO_HZ  = 7.5;             // near-max flutter
  const PANIC_CROSSFADE   = 0.5;             // fast dramatic cut
  const RESUME_CROSSFADE  = 1.5;             // gentler return
  if (process.stdin.isTTY) {
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.on("keypress", (str, key) => {
      if (!key) return;

      if (key.ctrl && key.name === "c") {
        console.log("[index] Ctrl+C — shutting down.");
        process.exit(0);
      }

      if (key.name === "f") {
        if (fallbackPlayer.active) {
          fallbackPlayer.stop();
        } else {
          fallbackPlayer.start();
        }
      }

      if (key.name === "s") {
        liveState.staticMode = !liveState.staticMode;
        console.log(
          liveState.staticMode
            ? `[index] STATIC MODE ON — all parameters frozen at current values (mood=${getActiveMood()})`
            : "[index] STATIC MODE OFF — live control resumed"
        );
      }

      if (key.name === "m") {
        liveState.oppositeMood = !liveState.oppositeMood;
        console.log(
          liveState.oppositeMood
            ? "[index] OPPOSITE-MOOD ON — calm↔tense inverted, energetic unchanged"
            : "[index] OPPOSITE-MOOD OFF — normal mood mapping restored"
        );
      }

      if (key.name === "p") {
        liveState.panicMode = !liveState.panicMode;
        if (liveState.panicMode) {
          // Activate panic: force tense stem, spike rate/filter/tremolo.
          // Fires even in static mode (intentional performer action, not noise).
          crossfadeTo("tense", PANIC_CROSSFADE);
          setPlaybackRate(PANIC_RATE);
          if (filterNode) filterNode.frequency.setTargetAtTime(PANIC_FILTER_HZ, context.currentTime, 0.05);
          if (lfo)        lfo.frequency.setTargetAtTime(PANIC_TREMOLO_HZ,  context.currentTime, 0.05);
          sessionTracker.recordPanic();
          console.log(
            `[index] PANIC MODE ON — tense stem, rate=${PANIC_RATE}, ` +
            `filter=${PANIC_FILTER_HZ}Hz, tremolo=${PANIC_TREMOLO_HZ}Hz`
          );
        } else {
          // Release panic: restore to classifier's current mood.
          // Rate/filter/tremolo restored by next live biometric/pencil messages.
          const resumeMood = liveState.oppositeMood
            ? MOOD_INVERSE[classifier.currentMood]
            : classifier.currentMood;
          crossfadeTo(resumeMood, RESUME_CROSSFADE);
          console.log(
            `[index] PANIC MODE OFF — returning to ${resumeMood} stem` +
            ` (classifier at ${classifier.currentMood})`
          );
        }
      }

      if (key.name === "r") {
        // Generate the performance portrait from session data so far.
        // Non-blocking — does not pause or affect audio.
        const data = sessionTracker.getSessionData();
        console.log(`[index] r pressed — triggering portrait generation`);
        generatePortrait(data);
      }
    });
    console.log("[index] keys: f=fallback  s=static  m=opposite-mood  p=panic  r=portrait  Ctrl+C=exit");
  } else {
    console.log("[index] stdin is not a TTY — keypress triggers disabled.");
  }
}

main().catch((err) => {
  console.error("[index] fatal error:", err);
  process.exitCode = 1;
});
