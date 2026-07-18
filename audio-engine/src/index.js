import { emitKeypressEvents } from "node:readline";
import { startServer } from "./server.js";
import { startPlayback } from "./playback.js";
import { FallbackPlayer } from "./fallback-player.js";
import { MoodClassifier } from "./mood-classifier.js";

async function main() {
  // Epic 9: startPlayback() now loads all 3 mood stems and returns
  // setPlaybackRate / crossfadeTo / getActiveMood instead of a bare sourceNode.
  // It fails fast if any stem file is missing.
  const {
    filterNode, pannerNode, lfo,
    setPlaybackRate, crossfadeTo, getActiveMood,
  } = await startPlayback();

  // Epic 9: stateful mood classifier with hysteresis.
  const classifier = new MoodClassifier();

  // Epic 8.5: mutable state object for runtime toggles (read from server.js
  // and toggled by the keypress handler below without passing callbacks).
  const liveState = {
    staticMode:   false,   // s key: freeze all parameters in place
    oppositeMood: false,   // m key: invert mood selection (CALM↔TENSE)
    panicMode:    false,   // p key: force TENSE stem at max intensity
  };

  // Epic 8: fallback player — now uses setPlaybackRate instead of sourceNode.
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
  });

  // ── Keypress handler ──────────────────────────────────────────────────────────
  //  f  → toggle fallback playback on/off  (Epic 8)
  //  s  → toggle static mode on/off        (Epic 8.5)
  //  m  → toggle opposite-mood on/off      (Epic 8.5)
  //  p  → toggle panic mode on/off         (Epic 9.5)
  //  r  → render session portrait          (Epic 9.5)
  //  Ctrl+C → clean exit
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
          console.log("[index] PANIC MODE ON — forcing TENSE stem at max intensity");
          crossfadeTo("tense", 0.5);
          setPlaybackRate(1.30);
          if (filterNode) filterNode.frequency.value = 8000;
          if (lfo) lfo.frequency.value = 7.5;
        } else {
          const resumeMood = liveState.oppositeMood
            ? (classifier.currentMood === "calm" ? "tense" : classifier.currentMood === "tense" ? "calm" : "energetic")
            : classifier.currentMood;
          console.log(`[index] PANIC MODE OFF — resuming mood=${resumeMood}`);
          crossfadeTo(resumeMood, 1.5);
        }
      }
    });
    console.log("[index] keys: f=fallback  s=static-mode  m=opposite-mood  p=panic  Ctrl+C=exit");
  } else {
    console.log("[index] stdin is not a TTY — keypress triggers disabled.");
  }
}

main().catch((err) => {
  console.error("[index] fatal error:", err);
  process.exitCode = 1;
});
