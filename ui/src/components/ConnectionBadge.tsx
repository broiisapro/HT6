import { motion, useReducedMotion } from "framer-motion";
import type { ConnectionStatus } from "../hooks/useEngineSocket";

const COPY: Record<ConnectionStatus, string> = {
  open: "Connected",
  connecting: "Reconnecting…",
  closed: "Disconnected",
};

const DOT_COLOR: Record<ConnectionStatus, string> = {
  open: "#4ade80",
  connecting: "#facc15",
  closed: "#f87171",
};

/** Always-visible connection indicator — deliberately calm, not alarming, but never lies about a dropped socket. */
export function ConnectionBadge({ status }: { status: ConnectionStatus }) {
  const reduceMotion = useReducedMotion();
  const color = DOT_COLOR[status];
  const pulsing = status === "connecting" && !reduceMotion;
  return (
    <div className="flex items-center gap-2 text-sm text-white/60">
      <motion.span
        className="inline-block h-2.5 w-2.5 rounded-full"
        style={{ backgroundColor: color }}
        animate={pulsing ? { opacity: [1, 0.35, 1] } : { opacity: 1 }}
        transition={pulsing ? { duration: 1.2, repeat: Infinity, ease: "easeInOut" } : undefined}
      />
      <span>{COPY[status]}</span>
    </div>
  );
}
