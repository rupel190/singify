/**
 * punch-header.ts — the "punched in proper" mark as an UltraStar header, so the
 * chart .txt itself carries it: `#SINGIFYPUNCHED:<offset ms>`. Open the file on
 * a fresh profile and the track is already marked, with its tuned offset.
 *
 * UltraStar players ignore tags they don't know, so the file stays valid.
 * Pure string work, no imports — shared by the parser and the helper.
 */

export const PUNCHED_TAG = "SINGIFYPUNCHED";

/** Set (offsetMs) or remove (null) the tag, leaving every other byte as it was. */
export function setPunchedHeader(raw: string, offsetMs: number | null): string {
  const bom = raw.startsWith("﻿") ? "﻿" : "";
  const body = bom ? raw.slice(1) : raw;
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  const lines = body.split(/\r?\n/);

  const isTag = (l: string) => l.slice(1, l.indexOf(":")).trim().toUpperCase() === PUNCHED_TAG;
  let headerEnd = 0; // index of the first non-header line
  while (headerEnd < lines.length && lines[headerEnd].startsWith("#")) headerEnd++;

  const headers = lines.slice(0, headerEnd).filter((l) => !isTag(l));
  if (offsetMs != null) headers.push(`#${PUNCHED_TAG}:${Math.round(offsetMs)}`);
  return bom + [...headers, ...lines.slice(headerEnd)].join(eol);
}
