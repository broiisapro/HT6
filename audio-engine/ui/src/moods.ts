import { Moon, Target, Sparkles, Zap, Wind, Activity, Flame } from "lucide-react";
import type { ComponentType, CSSProperties } from "react";
import type { Zone, Intention } from "./types";

export type MoodIcon = ComponentType<{ size?: number; strokeWidth?: number; className?: string; style?: CSSProperties }>;

export interface ZoneMeta {
  id: Zone;
  label: string;
  /** Deep, low-luminance wash color — tints the whole surface when this zone is active. */
  wash: string;
  /** Brighter accent for selected-state borders/icons/text. */
  accent: string;
  Icon: MoodIcon;
}

export const ZONES: ZoneMeta[] = [
  { id: "calm", label: "Calm", wash: "hsl(200, 55%, 9%)", accent: "hsl(195, 70%, 68%)", Icon: Moon },
  { id: "focused", label: "Focused", wash: "hsl(38, 55%, 9%)", accent: "hsl(38, 85%, 65%)", Icon: Target },
  { id: "dreamy", label: "Dreamy", wash: "hsl(280, 45%, 11%)", accent: "hsl(280, 70%, 74%)", Icon: Sparkles },
  { id: "energised", label: "Energised", wash: "hsl(8, 55%, 11%)", accent: "hsl(8, 85%, 64%)", Icon: Zap },
];

/** Fallback wash for before the first `state` broadcast arrives. */
export const NEUTRAL_WASH = "hsl(260, 18%, 7%)";
export const NEUTRAL_ACCENT = "hsl(260, 10%, 60%)";

export function zoneMeta(zone: Zone | null): ZoneMeta | null {
  return ZONES.find((z) => z.id === zone) ?? null;
}

export interface IntentionMeta {
  id: Intention;
  label: string;
  description: string;
  Icon: MoodIcon;
}

export const INTENTIONS: IntentionMeta[] = [
  {
    id: "calm_me_down",
    label: "Calm Me Down",
    description: "Elevated heart rate steers the music gradually calmer.",
    Icon: Wind,
  },
  {
    id: "match_my_energy",
    label: "Match My Energy",
    description: "Mood follows heart rate directly.",
    Icon: Activity,
  },
  {
    id: "lift_my_energy",
    label: "Lift My Energy",
    description: "Biases toward energetic moods sooner.",
    Icon: Flame,
  },
];
