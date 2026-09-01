/**
 * storage-keys.ts — the localStorage key names, defined ONCE.
 *
 * These strings are load-bearing on every side: the adapter (index.ts) reads and
 * writes them live, persist.ts mirrors a subset to disk by matching the SAME
 * names, and the harness pokes a couple for dev. While the lists were separate,
 * renaming a key in one silently broke the others — the mirror just stopped
 * gathering it (no error; settings quietly stopped saving). One source makes
 * that drift impossible.
 *
 * Pure data, no imports — safe in the renderer and the harness alike.
 */

export const SENS_KEY = "singify:sensitivity";
export const SENS_SCALE_KEY = "singify:sensitivityScale";
export const DIFFICULTY_KEY = "singify:difficulty";
export const NOWLINE_KEY = "singify:nowLinePx";
export const MIC_SLOTS_KEY = "singify:micSlots";
/** Legacy per-slot gates (pre-micSlots) — still read as a fallback. */
export const PLAYER_SENS_KEY = "singify:playerSens";
export const AUTOSKIP_KEY = "singify:autoSkipNoChart";
export const FPS_KEY = "singify:fps";

/** Baseline lyric offset for untuned tracks (doubles as the legacy global key). */
export const DEFAULT_OFFSET_KEY = "singify:offsetMs";
/** Per-track lyric offset — the full key is `${OFFSET_PREFIX}${trackId}`. */
export const OFFSET_PREFIX = "singify:offset:";
