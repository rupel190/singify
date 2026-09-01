/**
 * theme.ts — shared colour tokens (pure data; no imports, safe on both sides).
 *
 * Spotify's signature green and the karaoke gold were pasted as raw hex in a
 * dozen places; one source keeps every surface — menu, HUD, results, stats,
 * picker — on the exact same palette. Views still declare their own layout
 * colours locally; this holds only the handful that genuinely recur.
 */

/** Spotify green — the primary accent (buttons, active states, the now-line). */
export const ACCENT = "#1ed760";

/**
 * Karaoke gold — golden notes and top-score highlights. RESERVED: never a player
 * tint, or a lane's golden notes would blend into their own singer's colour.
 */
export const GOLD = "#e6b422";

/** Dark-surface palette shared by the full-screen panels (stats, song picker). */
export const SURFACE = {
  text: "#f2f2f5",
  sub: "#9a9aa6",
  card: "#16161c",
  border: "#2a2a33",
} as const;
