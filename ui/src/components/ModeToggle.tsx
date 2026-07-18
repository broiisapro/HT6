import { motion } from "framer-motion";
import type { EngineMode } from "../types";

interface ModeToggleProps {
  mode: EngineMode;
  onChange: (mode: EngineMode) => void;
}

const OPTIONS: { id: EngineMode; label: string }[] = [
  { id: "static", label: "Static" },
  { id: "dynamic", label: "Dynamic" },
];

/** Prominent Static/Dynamic segmented toggle at the top of the screen. */
export function ModeToggle({ mode, onChange }: ModeToggleProps) {
  return (
    <div className="relative flex w-full rounded-full border border-white/10 bg-white/5 p-1.5">
      {OPTIONS.map((option) => {
        const active = option.id === mode;
        return (
          <button
            key={option.id}
            type="button"
            onClick={() => onChange(option.id)}
            className="relative flex-1 rounded-full py-4 text-lg sm:text-xl font-medium tracking-tight transition-colors duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-2 focus-visible:ring-offset-black/40"
            style={{ color: active ? "#0b0a0d" : "rgba(255,255,255,0.65)" }}
          >
            {active && (
              <motion.span
                layoutId="mode-toggle-pill"
                className="absolute inset-0 rounded-full bg-white"
                transition={{ type: "spring", stiffness: 300, damping: 30 }}
              />
            )}
            <span className="relative">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
