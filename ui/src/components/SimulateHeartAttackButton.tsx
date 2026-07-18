import { useCallback, useState } from "react";

const COOLDOWN_MS = 30_000;

interface Props {
  onTrigger: () => boolean;
}

export function SimulateHeartAttackButton({ onTrigger }: Props) {
  const [cooldown, setCooldown] = useState(false);

  const handleClick = useCallback(() => {
    const sent = onTrigger();
    if (!sent) return;
    setCooldown(true);
    setTimeout(() => setCooldown(false), COOLDOWN_MS);
  }, [onTrigger]);

  return (
    <button
      type="button"
      disabled={cooldown}
      onClick={handleClick}
      className={`mt-8 rounded-full border px-6 py-3 text-sm font-semibold tracking-wider uppercase transition-all duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-2 focus-visible:ring-offset-black/40 ${
        cooldown
          ? "cursor-not-allowed border-red-900/40 bg-red-950/30 text-red-400/50"
          : "border-red-500/60 bg-red-600/10 text-red-400 hover:bg-red-600/20 active:scale-95"
      }`}
    >
      {cooldown ? "✅ Call Placed" : "🚨 Simulate Heart Attack"}
    </button>
  );
}
