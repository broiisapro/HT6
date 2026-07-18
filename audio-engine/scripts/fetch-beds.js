import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * One-time script — NOT part of the live server. Run manually:
 *   npm run fetch-beds
 *
 * Downloads the initial seed track for each mood zone into
 * audio-engine/assets/<zone>/<name>.mp3. Re-run only if a committed file is
 * ever lost — the live engine never fetches these at runtime/startup.
 *
 * Each zone folder can hold more than one track — playback.js picks
 * randomly from whatever's in the folder, so add more tracks straight into
 * assets/<zone>/ (any mp3/wav/ogg) with no code change needed. New zone
 * folders are auto-discovered too (see playback.js's listZones()).
 *
 * Zones are moods (calm/anxious-relief, happy/upbeat, hype/gym, ...), not
 * just heart-rate tiers — see assets/README.md for the current zone list,
 * including "chill" which has no seed track yet (deliberately left empty
 * for hand-picked sourcing). Mapping a live bpm/mood signal to a zone is
 * Epic 3's call, not decided here — this epic only prepares the assets and
 * a way to switch between them. This script only seeds three of them; all
 * are CC0 (public domain dedication, no attribution legally required,
 * credited below as good practice):
 *
 * - calm:  "Ambient Loop" by YellowTree
 *          https://freesound.org/people/YellowTree/sounds/438901/
 * - happy: "Upbeat124.wav" by BaDoink
 *          https://freesound.org/people/BaDoink/sounds/573986/
 * - hype:  "Race song loop" by neko_4444
 *          https://freesound.org/people/neko_4444/sounds/739064/
 *
 * See docs/epic-2-audio-engine-scaffold.md for the full decision history
 * (fal.ai -> single CC0 bed -> three zones -> per-zone track pools -> mood taxonomy).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.join(__dirname, "..", "assets");

const SEED_TRACKS = [
  {
    zone: "calm",
    fileName: "ambient-loop-yellowtree.mp3",
    url: "https://cdn.freesound.org/previews/438/438901_1954411-hq.mp3",
  },
  {
    zone: "happy",
    fileName: "upbeat124-badoink.mp3",
    url: "https://cdn.freesound.org/previews/573/573986_2019171-hq.mp3",
  },
  {
    zone: "hype",
    fileName: "race-song-loop-neko4444.mp3",
    url: "https://cdn.freesound.org/previews/739/739064_16072460-hq.mp3",
  },
];

async function fetchTrack({ zone, fileName, url }) {
  console.log(`[fetch-beds] downloading "${zone}/${fileName}" from ${url}`);
  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (audio-engine fetch-beds script)" },
  });
  if (!response.ok) {
    throw new Error(`Failed to download "${zone}/${fileName}": ${response.status} ${response.statusText}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const zoneDir = path.join(ASSETS_DIR, zone);
  await mkdir(zoneDir, { recursive: true });
  const outputPath = path.join(zoneDir, fileName);
  await writeFile(outputPath, buffer);
  console.log(`[fetch-beds] saved to ${outputPath} (${buffer.length} bytes)`);
}

async function main() {
  for (const track of SEED_TRACKS) {
    await fetchTrack(track);
  }
}

main().catch((err) => {
  console.error("[fetch-beds] failed:", err);
  process.exitCode = 1;
});
