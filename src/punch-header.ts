/**
 * punch-header.ts — the "punched in proper" mark as an UltraStar header, so the
 * chart .txt itself carries it. Open the file on a fresh profile and the track
 * is already marked, with its tuned offset.
 *
 *   #SINGIFYPUNCHED:<trackId>=<offset ms>,<trackId>=<offset ms>
 *
 * Keyed by Spotify track ID because one chart often serves several Spotify
 * versions of a song (album, single, remaster) whose offsets differ by tens of
 * seconds. The old unkeyed form (`#SINGIFYPUNCHED:-670`) can't say which version
 * it was for, so it's ignored on read and dropped on the next write.
 *
 * UltraStar players ignore tags they don't know, so the file stays valid.
 * Pure string work, no imports — shared by the parser and the helper.
 */

export const PUNCHED_TAG = "SINGIFYPUNCHED";

/** The bare ID of a Spotify track URI (`spotify:track:abc` → `abc`). */
export function trackKey(trackId: string): string {
  return trackId.split(":").pop() ?? trackId;
}

/** Parse the tag's value into { trackKey: offsetMs }. Legacy bare numbers are skipped. */
export function parsePunchedValue(value: string | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const entry of (value ?? "").split(",")) {
    const eq = entry.indexOf("=");
    if (eq < 0) continue; // legacy unkeyed offset — ambiguous across versions
    const key = entry.slice(0, eq).trim();
    const ms = parseFloat(entry.slice(eq + 1));
    if (key && Number.isFinite(ms)) out[key] = Math.round(ms);
  }
  return out;
}

/**
 * Set (offsetMs) or clear (null) this track's entry, leaving every other byte as
 * it was. The tag disappears once no track is marked.
 */
export function setPunchedHeader(raw: string, trackId: string, offsetMs: number | null): string {
  const bom = raw.startsWith("﻿") ? "﻿" : "";
  const body = bom ? raw.slice(1) : raw;
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  const lines = body.split(/\r?\n/);

  const isTag = (l: string) => l.slice(1, l.indexOf(":")).trim().toUpperCase() === PUNCHED_TAG;
  let headerEnd = 0; // index of the first non-header line
  while (headerEnd < lines.length && lines[headerEnd].startsWith("#")) headerEnd++;

  const old = lines.slice(0, headerEnd).find(isTag);
  const entries = parsePunchedValue(old?.slice(old.indexOf(":") + 1));
  const key = trackKey(trackId);
  if (offsetMs == null) delete entries[key];
  else entries[key] = Math.round(offsetMs);

  const headers = lines.slice(0, headerEnd).filter((l) => !isTag(l));
  const value = Object.entries(entries)
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
  if (value) headers.push(`#${PUNCHED_TAG}:${value}`);
  return bom + [...headers, ...lines.slice(headerEnd)].join(eol);
}
