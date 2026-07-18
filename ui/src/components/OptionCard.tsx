import { motion, useReducedMotion } from "framer-motion";
import { Check } from "lucide-react";
import type { MoodIcon } from "../moods";

interface OptionCardProps {
  label: string;
  description?: string;
  Icon: MoodIcon;
  selected: boolean;
  /** True for the brief window between an optimistic tap and the server's broadcast confirming it. */
  applying: boolean;
  accent: string;
  onSelect: () => void;
}

/**
 * A single tappable choice — reused for both mood options (Static mode) and
 * intention options (Dynamic mode) since they're the same shape: an icon, a
 * label, an optional one-line description, and exactly-one-selected
 * behavior enforced by the parent. Selected cards get a slow "breathing"
 * pulse (deliberately gentle — this is a live instrument, not a game UI).
 */
export function OptionCard({ label, description, Icon, selected, applying, accent, onSelect }: OptionCardProps) {
  const reduceMotion = useReducedMotion();

  return (
    <motion.button
      type="button"
      onClick={onSelect}
      whileTap={{ scale: 0.97 }}
      animate={
        selected
          ? { scale: reduceMotion ? 1 : [1, 1.015, 1], opacity: 1 }
          : { scale: 1, opacity: 0.72 }
      }
      transition={
        selected && !reduceMotion
          ? { duration: 3.2, repeat: Infinity, ease: "easeInOut" }
          : { duration: 0.4, ease: "easeOut" }
      }
      className="relative flex flex-col items-start gap-3 rounded-3xl border p-6 text-left transition-colors duration-500 min-h-26 sm:min-h-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-2 focus-visible:ring-offset-black/40"
      style={{
        borderColor: selected ? accent : "rgba(255,255,255,0.08)",
        backgroundColor: selected ? `color-mix(in srgb, ${accent} 14%, transparent)` : "rgba(255,255,255,0.03)",
        boxShadow: selected ? `0 0 32px -8px ${accent}` : "none",
      }}
    >
      <div className="flex w-full items-center justify-between">
        <Icon size={30} strokeWidth={1.75} className="shrink-0" style={{ color: selected ? accent : "rgba(255,255,255,0.55)" }} />
        {selected && (
          <motion.span
            initial={{ opacity: 0, scale: 0.6 }}
            animate={{ opacity: applying ? 0.45 : 1, scale: 1 }}
            className="flex items-center gap-1 text-xs font-medium uppercase tracking-wide"
            style={{ color: accent }}
          >
            {applying ? "Applying…" : (
              <>
                <Check size={14} strokeWidth={2.5} /> Applied
              </>
            )}
          </motion.span>
        )}
      </div>
      <span className="text-xl sm:text-2xl font-medium tracking-tight text-white/90">{label}</span>
      {description && <span className="text-sm leading-snug text-white/60">{description}</span>}
    </motion.button>
  );
}
