// Message shapes mirrored from ../../../contracts/README.md (Epic 9's
// additive `mode`/`state` messages). Keep in sync with that file by hand —
// audio-engine/ owns the contract, this UI is just a client of it.

export type Zone = "calm" | "focused" | "dreamy" | "energised";

export type Intention = "calm_me_down" | "match_my_energy" | "lift_my_energy";

export type EngineMode = "static" | "dynamic";

export interface ModeMessage {
  type: "mode";
  mode: EngineMode;
  zone: Zone | null;
  intention: Intention | null;
  timestamp: number;
}

export interface StateBroadcast {
  type: "state";
  mode: EngineMode;
  zone: Zone | null;
  pinnedZone: Zone | null;
  intention: Intention | null;
  timestamp: number;
}
