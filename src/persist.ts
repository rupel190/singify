/**
 * persist.ts — durable, XDG-backed persistence for the renderer.
 *
 * localStorage stays the LIVE store: synchronous, always available, works with
 * the helper off. But the parts worth keeping are mirrored to disk through the
 * helper, in their proper XDG homes:
 *   settings → ~/.config/singify/settings.json   (mic gear, difficulty, gates…)
 *   offsets  → ~/.local/share/singify/offsets.json (per-track punch-ins)
 *   stats    → ~/.local/share/singify/stats.json   (round history)
 *
 * On boot we SEED any localStorage key that's missing from disk, so a wiped
 * Spotify profile (localStorage lives buried in Spotify's own Chromium profile)
 * restores its tunings and history. Writes are debounced; a down helper just
 * means the value waits in localStorage until it's back.
 */

import { loadStore, saveStore } from "./resolver-client";
import type { StatRound, StatsDoc } from "./stats";

// The localStorage keys that belong to the "settings" store. These MIRROR the
// key strings the adapter (index.ts) reads/writes — keep in sync if you add a knob.
const SETTINGS_KEYS = [
  "singify:sensitivity",
  "singify:sensitivityScale",
  "singify:difficulty",
  "singify:nowLinePx",
  "singify:micSlots",
  "singify:playerSens",
  "singify:autoSkipNoChart",
];
const OFFSET_PREFIX = "singify:offset:"; // per-track punch-ins
const OFFSET_GLOBAL = "singify:offsetMs"; // baseline for untuned tracks

function ls(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function gather(keys: string[]): Record<string, string> {
  const store = ls();
  const out: Record<string, string> = {};
  if (!store) return out;
  for (const k of keys) {
    const v = store.getItem(k);
    if (v != null) out[k] = v;
  }
  return out;
}

function gatherOffsets(): Record<string, string> {
  const store = ls();
  const out: Record<string, string> = {};
  if (!store) return out;
  for (let i = 0; i < store.length; i++) {
    const k = store.key(i);
    if (k && (k === OFFSET_GLOBAL || k.startsWith(OFFSET_PREFIX))) {
      const v = store.getItem(k);
      if (v != null) out[k] = v;
    }
  }
  return out;
}

/** Coalesce a burst of taps into one write. */
function debounce(fn: () => void, ms: number): () => void {
  let t = 0;
  return () => {
    clearTimeout(t);
    t = window.setTimeout(fn, ms);
  };
}

const pushSettings = debounce(() => {
  void saveStore("settings", gather(SETTINGS_KEYS)).catch(() => {});
}, 600);
const pushOffsets = debounce(() => {
  void saveStore("offsets", gatherOffsets()).catch(() => {});
}, 600);

/** Call after any settings change (sensitivity, difficulty, mic slots, …). */
export function mirrorSettings(): void {
  pushSettings();
}
/** Call after any per-track offset / punch-in change. */
export function mirrorOffsets(): void {
  pushOffsets();
}

/**
 * Seed localStorage from disk for any key it's MISSING (fresh/wiped profile).
 * Never overwrites a key already present — localStorage is the live truth while
 * running. Returns the keys it restored, so the adapter can re-apply the live
 * ones it had already read at module load. Silent no-op if the helper is down.
 */
export async function seedFromHelper(): Promise<string[]> {
  const store = ls();
  if (!store) return [];
  const restored: string[] = [];
  try {
    const [settings, offsets] = await Promise.all([
      loadStore<Record<string, string>>("settings"),
      loadStore<Record<string, string>>("offsets"),
    ]);
    for (const src of [settings, offsets]) {
      for (const [k, v] of Object.entries(src ?? {})) {
        if (typeof v === "string" && store.getItem(k) == null) {
          store.setItem(k, v);
          restored.push(k);
        }
      }
    }
  } catch {
    /* helper down → keep whatever localStorage already had */
  }
  return restored;
}

// ── Stats ────────────────────────────────────────────────────────────────────
// The in-memory copy is authoritative ONLY after a successful load — we never
// write until we've read the existing file, so a round recorded while the helper
// was down can't clobber the on-disk history. Such rounds wait in `pending` and
// merge in on the next successful load.

let statsCache: StatRound[] | null = null;
let pending: StatRound[] = [];

const pushStats = debounce(() => {
  if (statsCache) {
    const doc: StatsDoc = { rounds: statsCache };
    void saveStore("stats", doc).catch(() => {});
  }
}, 400);

/** The authoritative round list once loaded, else null (helper unreachable). */
async function ensureLoaded(): Promise<StatRound[] | null> {
  if (statsCache) return statsCache;
  try {
    const doc = await loadStore<Partial<StatsDoc>>("stats");
    const rounds = Array.isArray(doc?.rounds) ? (doc!.rounds as StatRound[]) : [];
    if (pending.length) {
      rounds.push(...pending);
      pending = [];
      statsCache = rounds;
      pushStats(); // flush the merged-in buffered rounds
    } else {
      statsCache = rounds;
    }
    return statsCache;
  } catch {
    return null; // still unreachable — don't fabricate an empty authoritative set
  }
}

export interface StatsLoad {
  rounds: StatRound[];
  /** false = the helper was unreachable, so on-disk history couldn't be read. */
  reachable: boolean;
}

/** Round history for the stats screen. `reachable:false` means the helper is
 *  down — the screen should say so rather than imply there's no history. */
export async function loadStatRounds(): Promise<StatsLoad> {
  const rounds = await ensureLoaded();
  if (rounds) return { rounds, reachable: true };
  return { rounds: [...pending], reachable: false };
}

/** Append one finished round; flush to disk (debounced) once history is loaded. */
export function recordStatRound(round: StatRound): void {
  void (async () => {
    const rounds = await ensureLoaded();
    if (rounds) {
      rounds.push(round);
      pushStats();
    } else {
      pending.push(round); // helper down — hold; merges on next successful load
    }
  })();
}
