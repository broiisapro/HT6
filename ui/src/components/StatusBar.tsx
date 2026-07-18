import { AnimatePresence, motion } from "framer-motion";
import type { ConnectionStatus } from "../hooks/useEngineSocket";
import type { StateBroadcast } from "../types";
import { zoneMeta, INTENTIONS } from "../moods";
import { ConnectionBadge } from "./ConnectionBadge";

interface StatusBarProps {
  status: ConnectionStatus;
  state: StateBroadcast | null;
}

/** Always-visible readout of what the engine is actually doing right now — the broadcast is the source of truth, not the tap. */
export function StatusBar({ status, state }: StatusBarProps) {
  const zone = zoneMeta(state?.zone ?? null);
  const intentionLabel = INTENTIONS.find((i) => i.id === state?.intention)?.label;

  return (
    <div className="flex flex-col gap-2 border-t border-white/10 pt-4 sm:flex-row sm:items-center sm:justify-between">
      <AnimatePresence mode="wait">
        <motion.span
          key={`${state?.mode ?? "…"}-${state?.zone ?? "…"}-${state?.intention ?? "…"}`}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.4 }}
          className="text-base sm:text-lg text-white/70"
        >
            {state ? (
              state.mode === "static" ? (
                <>
                  Static — pinned to <span className="font-medium text-white/90">{zone?.label ?? "…"}</span>
                </>
              ) : (
                <>
                  Dynamic — <span className="font-medium text-white/90">{intentionLabel ?? "…"}</span>, currently{" "}
                  <span className="font-medium text-white/90">{zone?.label ?? "…"}</span>
                </>
              )
            ) : (
              "Waiting for engine…"
            )}
          </motion.span>
      </AnimatePresence>
      <ConnectionBadge status={status} />
    </div>
  );
}
