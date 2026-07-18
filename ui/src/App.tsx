import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { useEngineSocket } from "./hooks/useEngineSocket";
import { ModeToggle } from "./components/ModeToggle";
import { OptionCard } from "./components/OptionCard";
import { StatusBar } from "./components/StatusBar";
import { ZONES, INTENTIONS, zoneMeta, NEUTRAL_WASH, NEUTRAL_ACCENT } from "./moods";
import type { EngineMode, Intention, Zone } from "./types";

/** How long an optimistic tap is shown as "Applying…" before we give up waiting for the broadcast to confirm it (e.g. if the socket drops mid-send). */
const APPLY_TIMEOUT_MS = 2500;

interface Pending {
  mode: EngineMode;
  zone: Zone | null;
  intention: Intention | null;
}

export default function App() {
  const { status, state, sendMode } = useEngineSocket();
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear the optimistic layer once the broadcast catches up to it.
  useEffect(() => {
    if (!pending || !state) return;
    const matches =
      state.mode === pending.mode &&
      (pending.mode === "static" ? state.pinnedZone === pending.zone : state.intention === pending.intention);
    if (matches) {
      setPending(null);
      if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current);
    }
  }, [state, pending]);

  useEffect(() => () => {
    if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current);
  }, []);

  function apply(next: Pending) {
    const sent = sendMode(next.mode, next.zone, next.intention);
    if (!sent) return;
    setPending(next);
    if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current);
    pendingTimerRef.current = setTimeout(() => setPending(null), APPLY_TIMEOUT_MS);
  }

  const effectiveMode = pending?.mode ?? state?.mode ?? "dynamic";
  const effectiveZone = pending ? pending.zone : state?.pinnedZone ?? null;
  const effectiveIntention = pending ? pending.intention : state?.intention ?? "match_my_energy";

  const wash = zoneMeta(state?.zone ?? null)?.wash ?? NEUTRAL_WASH;
  const accent = zoneMeta(state?.zone ?? null)?.accent ?? NEUTRAL_ACCENT;

  function handleModeChange(mode: EngineMode) {
    if (mode === effectiveMode) return;
    if (mode === "static") {
      apply({ mode: "static", zone: effectiveZone ?? state?.zone ?? "calm", intention: null });
    } else {
      apply({ mode: "dynamic", zone: null, intention: effectiveIntention ?? "match_my_energy" });
    }
  }

  const disconnected = status !== "open";

  return (
    <motion.div
      className="min-h-svh w-full"
      animate={{ backgroundColor: wash }}
      transition={{ duration: 1.6, ease: "easeInOut" }}
    >
      {/* Vignette for depth — static, not part of the animated wash. */}
      <div
        className="pointer-events-none fixed inset-0"
        style={{ background: "radial-gradient(ellipse at 50% 0%, transparent 0%, rgba(0,0,0,0.55) 100%)" }}
      />

      <div className="relative mx-auto flex min-h-svh w-full max-w-xl flex-col gap-8 px-6 py-8 sm:px-10 sm:py-12">
        <header>
          <h1 className="text-sm font-medium uppercase tracking-[0.2em] text-white/50">Human MIDI</h1>
        </header>

        <ModeToggle mode={effectiveMode} onChange={handleModeChange} />

        <div
          className="flex flex-1 flex-col justify-center gap-4 transition-opacity duration-300"
          style={{ opacity: disconnected ? 0.45 : 1, pointerEvents: disconnected ? "none" : "auto" }}
        >
          {effectiveMode === "static" ? (
            <div className="grid grid-cols-2 gap-4">
              {ZONES.map((zone) => (
                <OptionCard
                  key={zone.id}
                  label={zone.label}
                  Icon={zone.Icon}
                  accent={zone.accent}
                  selected={effectiveZone === zone.id}
                  applying={Boolean(pending) && effectiveZone === zone.id}
                  onSelect={() => apply({ mode: "static", zone: zone.id, intention: null })}
                />
              ))}
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {INTENTIONS.map((intention) => (
                <OptionCard
                  key={intention.id}
                  label={intention.label}
                  description={intention.description}
                  Icon={intention.Icon}
                  accent={accent}
                  selected={effectiveIntention === intention.id}
                  applying={Boolean(pending) && effectiveIntention === intention.id}
                  onSelect={() => apply({ mode: "dynamic", zone: null, intention: intention.id })}
                />
              ))}
            </div>
          )}
        </div>

        <StatusBar status={status} state={state} />
      </div>
    </motion.div>
  );
}
