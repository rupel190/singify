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
/** When a session last started from each playlist — JSON { playlistUri: ms }. */
export const PLAYLIST_PLAYED_KEY = "singify:playlistPlayed";

/** Baseline lyric offset for untuned tracks (doubles as the legacy global key). */
export const DEFAULT_OFFSET_KEY = "singify:offsetMs";
/** Per-track lyric offset — the full key is `${OFFSET_PREFIX}${trackId}`. */
export const OFFSET_PREFIX = "singify:offset:";
/** "Punched in proper" mark — `${PUNCHED_PREFIX}${trackUri}` = "1" while set. */
export const PUNCHED_PREFIX = "singify:punched:";
/** Auto-sync curve for a chart that drifts or jumps — `${SYNC_CURVE_PREFIX}${trackUri}` = JSON knots. */
export const SYNC_CURVE_PREFIX = "singify:syncCurve:";
/** Auto-sync bias samples learned from punched tracks — JSON { trackUri: ms }. */
export const SYNC_BIAS_KEY = "singify:syncBias";
/** Auto-sync set or confirmed this track's offset — `${AUTOSYNCED_PREFIX}${trackUri}` = "1"/"0". */
export const AUTOSYNCED_PREFIX = "singify:autosynced:";
/** A lookup found no chart for this track — `${NOCHART_PREFIX}${trackUri}` = "1"/"0". */
export const NOCHART_PREFIX = "singify:nochart:";
/** Auto-sync found the chart doesn't fit this recording — `${UNRELIABLE_PREFIX}${trackUri}` = "drift"/"step"/"0". */
export const UNRELIABLE_PREFIX = "singify:unreliable:";
/** Per-element UI size from the resize handles — `${UI_SIZE_PREFIX}<element id>`. */
export const UI_SIZE_PREFIX = "singify:uiSize:";
