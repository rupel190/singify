/**
 * punched-badges.ts — a small ✓ next to "punched in proper" songs in Spotify's
 * own track lists (playlists, albums, queue).
 *
 * Spotify renders rows with React and recycles them as you scroll, so this is a
 * MutationObserver that re-decorates any row it sees. A row doesn't carry its
 * URI in the DOM; it's read from the React fiber's props, walking up until one
 * has `uri`. That's internal and could break on a Spotify update — when it does,
 * the badges just stop appearing; nothing else depends on them.
 */

const ROW = ".main-trackList-trackListRow";
const TITLE = ".main-trackList-rowTitle";
const BADGE_CLASS = "singify-punched-badge";

function rowUri(row: Element): string | null {
  const fiberKey = Object.keys(row).find((k) => k.startsWith("__reactFiber"));
  let fiber: any = fiberKey ? (row as any)[fiberKey] : null;
  for (let depth = 0; fiber && depth < 30; depth++, fiber = fiber.return) {
    const uri = fiber.memoizedProps?.uri ?? fiber.memoizedProps?.item?.uri;
    if (typeof uri === "string" && uri.startsWith("spotify:")) return uri;
  }
  return null;
}

function decorate(row: Element, isPunched: (uri: string) => boolean): void {
  const title = row.querySelector(TITLE);
  if (!title) return;
  const uri = rowUri(row);
  const want = uri != null && isPunched(uri);
  // Rows are recycled — a badge may belong to the song that USED to be here.
  const badge = title.querySelector(`.${BADGE_CLASS}`);
  if (want && !badge) {
    const el = document.createElement("span");
    el.className = BADGE_CLASS;
    el.textContent = "✓";
    el.title = "Singify: punched in proper";
    Object.assign(el.style, {
      marginInlineStart: "6px",
      color: "#1ed760",
      fontWeight: "700",
    });
    title.appendChild(el);
  } else if (!want && badge) {
    badge.remove();
  }
}

/** Start decorating; returns `refresh()` to re-check every visible row (after a toggle). */
export function startPunchedBadges(isPunched: (uri: string) => boolean): () => void {
  const refresh = () => {
    for (const row of document.querySelectorAll(ROW)) decorate(row, isPunched);
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
