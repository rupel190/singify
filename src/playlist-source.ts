/**
 * playlist-source.ts — read the user's Spotify playlists via Spicetify's
 * Platform APIs, for sourcing a multi-round session.
 *
 * Split like the rest of the codebase: the *mapping* from Spotify's loose,
 * version-varying API objects into our tidy shapes (toPlaylistRef /
 * toSessionTrack) is pure and unit-tested; the *fetching* (fetchPlaylists /
 * fetchPlaylistTracks / playPlaylist) is a thin, defensively-guarded wrapper
 * over `Spicetify.Platform.*`, which we can't exercise off a live client.
 *
 * The Platform API shapes drift between Spotify versions, so every field access
 * is optional-chained with fallbacks, and a missing API degrades to [] rather
 * than throwing — the caller shows "no playlists" instead of white-screening.
 */

import type { SessionTrack } from "./session";

export interface PlaylistRef {
  uri: string;
  name: string;
  count: number | null; // track count if the API reports it
}

// ── Pure mappers (tested) ────────────────────────────────────────────────────

/** True for a Spotify playlist URI (not a folder/album/artist/etc.). */
export function isPlaylistUri(uri: unknown): uri is string {
  return typeof uri === "string" && /^spotify:(?:user:[^:]+:)?playlist:/.test(uri);
}

/**
 * Map one RootlistAPI item to a PlaylistRef, or null when it isn't a playlist
 * (folders, or malformed rows). Field names differ across versions, so we probe
 * a few: name from `name`, count from `totalLength` / `metadata` variants.
 */
export function toPlaylistRef(item: unknown): PlaylistRef | null {
  if (!item || typeof item !== "object") return null;
  const o = item as Record<string, any>;
  const uri: unknown = o.uri;
  if (!isPlaylistUri(uri)) return null;

  const name =
    (typeof o.name === "string" && o.name) ||
    (typeof o.metadata?.name === "string" && o.metadata.name) ||
    "Untitled playlist";

  const rawCount =
    o.totalLength ?? o.length ?? o.metadata?.total_length ?? o.metadata?.length;
  const count = Number.isFinite(Number(rawCount)) ? Number(rawCount) : null;

  return { uri, name, count };
}

/**
 * Map one PlaylistAPI track item to a SessionTrack, or null when it's not a
 * playable track (local files with no URI, unavailable rows, episodes). Some
 * versions nest the track under `.track`; artists may be a list or a joined
 * string.
 */
export function toSessionTrack(item: unknown): SessionTrack | null {
  if (!item || typeof item !== "object") return null;
  const o = item as Record<string, any>;
  const t: Record<string, any> = o.track && typeof o.track === "object" ? o.track : o;

  const uri: unknown = t.uri;
  if (typeof uri !== "string" || !uri.startsWith("spotify:track:")) return null;

  const title = (typeof t.name === "string" && t.name) || "";

  let artist = "";
  if (Array.isArray(t.artists)) {
    artist = t.artists
      .map((a: any) => (typeof a === "string" ? a : a?.name))
      .filter(Boolean)
      .join(", ");
  } else if (typeof t.artists === "string") {
    artist = t.artists;
  } else if (typeof t.artistName === "string") {
    artist = t.artistName;
  }

  return { uri, title, artist };
}

/**
 * Map the current playback context (Spicetify.Player.data.context) to a
 * PlaylistRef when the user is playing a playlist, else null. The count is
 * unknown from the context alone (null) — the caller fetches tracks on start.
 * Name lives under different keys across versions (name / context_description).
 */
export function contextToPlaylistRef(ctx: unknown): PlaylistRef | null {
  if (!ctx || typeof ctx !== "object") return null;
  const o = ctx as Record<string, any>;
  const uri: unknown = o.uri ?? o.contextUri;
  if (!isPlaylistUri(uri)) return null;
  const name =
    (typeof o.name === "string" && o.name) ||
    (typeof o.metadata?.context_description === "string" && o.metadata.context_description) ||
    (typeof o.metadata?.name === "string" && o.metadata.name) ||
    "Current playlist";
  return { uri, name, count: null };
}

/** Flatten a RootlistAPI tree (folders nest playlists) into PlaylistRefs. */
export function flattenRootlist(root: unknown): PlaylistRef[] {
  const out: PlaylistRef[] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const o = node as Record<string, any>;
    const ref = toPlaylistRef(o);
    if (ref) out.push(ref);
    // Folders carry their children under `items` (or legacy `rows`).
    const kids = o.items ?? o.rows;
    if (Array.isArray(kids)) for (const k of kids) visit(k);
  };
  const items = (root as any)?.items ?? (root as any)?.rows ?? root;
  if (Array.isArray(items)) for (const it of items) visit(it);
  return out;
}

// ── Thin Spicetify wrappers (not unit-tested — need a live client) ───────────

type PlatformShape = {
  RootlistAPI?: { getContents?: (opts?: unknown) => Promise<unknown> };
  PlaylistAPI?: { getContents?: (uri: string, opts?: unknown) => Promise<unknown> };
  PlayerAPI?: { play?: (ctx: unknown, opts: unknown, meta: unknown) => Promise<void> };
};

function platform(): PlatformShape | null {
  const p = (Spicetify as unknown as { Platform?: PlatformShape }).Platform;
  return p ?? null;
}

/** The user's playlists (folders flattened), or [] if the API is unavailable. */
export async function fetchPlaylists(): Promise<PlaylistRef[]> {
  const api = platform()?.RootlistAPI;
  if (!api?.getContents) return [];
  try {
    const root = await api.getContents({ limit: 1000 });
    return flattenRootlist(root);
  } catch (err) {
    console.error("[singify] fetchPlaylists failed:", err);
    return [];
  }
}

/**
 * The playlist the user is currently playing, or null (not playing a playlist,
 * or the API is unavailable). Synchronous — reads Player.data.context.
 */
export function currentContextPlaylist(): PlaylistRef | null {
  try {
    const data = (Spicetify.Player as unknown as { data?: Record<string, any> })?.data;
    if (!data) return null;
    // Prefer the structured context; fall back to legacy flat fields.
    const ctx =
      data.context ?? { uri: data.contextUri, metadata: data.contextMetadata };
    return contextToPlaylistRef(ctx);
  } catch (err) {
    console.error("[singify] currentContextPlaylist failed:", err);
    return null;
  }
}

/** A playlist's tracks in order, or [] on failure. */
export async function fetchPlaylistTracks(uri: string): Promise<SessionTrack[]> {
  const api = platform()?.PlaylistAPI;
  if (!api?.getContents) return [];
  try {
    const res = (await api.getContents(uri)) as Record<string, any>;
    const items = res?.items ?? res?.rows ?? [];
    return (Array.isArray(items) ? items : [])
      .map(toSessionTrack)
      .filter((t): t is SessionTrack => t != null);
  } catch (err) {
    console.error("[singify] fetchPlaylistTracks failed:", err);
    return [];
  }
}

/**
 * Start playback of a playlist from its first track. Prefers the legacy
 * Player.playUri (present on most builds); falls back to PlayerAPI.play.
 * Returns true if a playback call was issued.
 */
export async function playPlaylist(uri: string): Promise<boolean> {
  const player = Spicetify.Player as unknown as {
    playUri?: (uri: string) => void;
  };
  if (typeof player.playUri === "function") {
    try {
      player.playUri(uri);
      return true;
    } catch (err) {
      console.error("[singify] playUri failed, trying PlayerAPI:", err);
    }
  }
  const api = platform()?.PlayerAPI;
  if (api?.play) {
    try {
      await api.play({ uri }, {}, {});
      return true;
    } catch (err) {
      console.error("[singify] PlayerAPI.play failed:", err);
    }
  }
  return false;
}
