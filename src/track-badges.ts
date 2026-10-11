/**
 * track-badges.ts — Singify's verdict on a song, next to its title in Spotify's
 * own track lists (playlists, albums, Liked Songs, queue):
 *
 *   ✓  punched in proper — sync checked by ear
 *   ⚠  chart doesn't fully match this recording (tempo drift / a section differs)
 *   ◐  auto-synced from Spotify's lyrics
 *   ∅  searched, no karaoke chart found
 *
 * Spotify renders rows with React and recycles them as you scroll, so this is a
 * MutationObserver that re-decorates any row it sees. A row doesn't carry its
 * URI in the DOM; it's read from the React fiber's props, walking up until one
 * has `uri`. Row and title class names are Spotify internals and change between
 * versions (the title selector here is the 1.2.95 one) — when they break, the
 * badges just stop appearing; nothing else depends on them.
 */

export type TrackBadge = "punched" | "unreliable" | "auto" | "nochart";

/** What a row shows: a badge, plus optional detail for its tooltip. */
export interface BadgeState {
  kind: TrackBadge;
  note?: string;
}

const ROW = ".main-trackList-trackListRow";
// Older clients had a dedicated title class; 1.2.9x puts the title text first
// inside the row's main content.
const TITLE = ".main-trackList-rowTitle, .main-trackList-rowMainContent > [data-encore-id=text]";
const BADGE_CLASS = "singify-track-badge";

const LOOK: Record<TrackBadge, { text: string; color: string; title: string }> = {
  punched: { text: "✓", color: "#1ed760", title: "Singify: punched in proper" },
  // U+FE0E asks for the plain text glyph, not the colour emoji.
  unreliable: { text: "⚠\uFE0E", color: "#f5a623", title: "Singify: chart may not match this recording" },
  auto: { text: "◐", color: "#1ed760", title: "Singify: auto-synced from Spotify's lyrics" },
  nochart: { text: "∅", color: "rgba(255,255,255,0.35)", title: "Singify: no karaoke chart found" },
};

function rowUri(row: Element): string | null {
  const fiberKey = Object.keys(row).find((k) => k.startsWith("__reactFiber"));
  let fiber: any = fiberKey ? (row as any)[fiberKey] : null;
  for (let depth = 0; fiber && depth < 30; depth++, fiber = fiber.return) {
    const uri = fiber.memoizedProps?.uri ?? fiber.memoizedProps?.item?.uri;
    if (typeof uri === "string" && uri.startsWith("spotify:")) return uri;
  }
  return null;
}

function decorate(row: Element, badgeFor: (uri: string) => BadgeState | null): void {
  const title = row.querySelector(TITLE);
  if (!title) return;
  const uri = rowUri(row);
  const want = uri ? badgeFor(uri) : null;
  // Rows are recycled — a badge may belong to the song that USED to be here.
  let el = title.querySelector<HTMLSpanElement>(`.${BADGE_CLASS}`);
  if (!want) {
    el?.remove();
    return;
  }
  const key = want.kind + (want.note ?? "");
  if (el?.dataset.badge === key) return;
  if (!el) {
    el = document.createElement("span");
    el.className = BADGE_CLASS;
    Object.assign(el.style, { marginInlineStart: "6px", fontWeight: "700" });
    title.appendChild(el);
  }
  const look = LOOK[want.kind];
  el.dataset.badge = key;
  el.textContent = look.text;
  el.title = want.note ? `${look.title} — ${want.note}` : look.title;
  el.style.color = look.color;
}

/** Start decorating; returns `refresh()` to re-check every visible row after a change. */
export function startTrackBadges(badgeFor: (uri: string) => BadgeState | null): () => void {
  const refresh = () => {
    for (const row of document.querySelectorAll(ROW)) decorate(row, badgeFor);
  };
  let pending = 0;
  new MutationObserver(() => {
    // Coalesce scroll bursts into one pass per frame.
    if (pending) return;
    pending = requestAnimationFrame(() => {
      pending = 0;
      refresh();
    });
  }).observe(document.body, { childList: true, subtree: true });
  refresh();
  return refresh;
}
