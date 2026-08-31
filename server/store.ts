/**
 * store.ts — tiny whitelisted document store for the helper.
 *
 * The renderer has no filesystem, so anything it wants to keep on disk in a
 * proper XDG location goes through here (see src/persist.ts). Three stores, each
 * a single JSON file, split by what the data IS:
 *
 *   settings → ~/.config/singify/settings.json        (things you set: mic gear, difficulty…)
 *   offsets  → ~/.local/share/singify/offsets.json    (per-track punch-ins — durable data)
 *   stats    → ~/.local/share/singify/stats.json       (round history — irreplaceable)
 *
 * The chart cache stays in ~/.cache/singify (regenerable — see src/cache.ts).
 *
 * The name→file WHITELIST is the whole security model: a request names a store,
 * never a path, so there's no way to read or clobber an arbitrary file.
 */

import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";

function configHome(): string {
  return process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
}
function dataHome(): string {
  return process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
}

/** The only names that map to a file. Anything else is unknown → not a path. */
const STORES: Record<string, () => string> = {
  settings: () => join(configHome(), "singify", "settings.json"),
  offsets: () => join(dataHome(), "singify", "offsets.json"),
  stats: () => join(dataHome(), "singify", "stats.json"),
};

export function storePath(name: string): string | null {
  return STORES[name]?.() ?? null;
}

/**
 * Read a whitelisted store. `{}` when the file is missing or corrupt (a wiped or
 * half-written file shouldn't 500 the caller); `undefined` when the NAME itself
 * isn't a known store, which the route turns into a 404.
 */
export async function readStore(name: string): Promise<unknown | undefined> {
  const file = storePath(name);
  if (!file) return undefined;
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return {}; // corrupt → treat as empty rather than erroring
  }
}

/**
 * Write a whitelisted store atomically (temp file + rename), so a crash mid-write
 * can never leave a truncated JSON that loses the whole store. Returns false when
 * the name is unknown.
 */
export async function writeStore(name: string, data: unknown): Promise<boolean> {
  const file = storePath(name);
  if (!file) return false;
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await rename(tmp, file); // atomic swap on the same filesystem
  return true;
}
