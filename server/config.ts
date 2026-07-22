/**
 * config.ts — helper configuration.
 *
 * Reads ~/.config/spicetify-karaoke/config.json, with environment-variable
 * overrides (handy for dev without writing a file). All fields optional; the
 * server still starts without credentials (so /health works and the user gets
 * a clear message) — it just can't reach USDB until they're set.
 *
 *   { "usdbUser": "...", "usdbPass": "...", "port": 4455, "cacheDir": "...",
 *     "chartsDir": ["/abs/one", "/abs/two"] }
 *
 * chartsDir is the local UltraStar folder(s) autoload resolves against. It may
 * be a single path or a list; every listed folder is scanned and unioned, and
 * non-existent ones are skipped — so you can point at a stable home dir AND a
 * dev repo dir and whichever exists contributes. Env override
 * SINGIFY_CHARTS_DIR is colon-separated (PATH-style). Defaults to
 * ~/.config/spicetify-karaoke/charts plus ./charts (relative to launch dir).
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readFileSync, existsSync } from "node:fs";

interface RawFileConfig {
  usdbUser?: string;
  usdbPass?: string;
  port?: number;
  cacheDir?: string;
  chartsDir?: string | string[];
}

export interface HelperConfig {
  usdbUser?: string;
  usdbPass?: string;
  port: number;
  cacheDir?: string;
  chartsDirs: string[]; // absolute, deduped, scan order
}

export const DEFAULT_PORT = 4455;

export function configPath(): string {
  return join(homedir(), ".config", "spicetify-karaoke", "config.json");
}

/** Absolute default chart folders, in scan order: stable home first, repo dir second. */
function defaultChartsDirs(): string[] {
  return [
    join(homedir(), ".config", "spicetify-karaoke", "charts"),
    join(process.cwd(), "charts"),
  ];
}

/** Resolve chartsDir config (env > file > default) to a deduped absolute list. */
function resolveChartsDirs(file: RawFileConfig): string[] {
  const env = process.env.SINGIFY_CHARTS_DIR;
  let raw: string[];
  if (env) {
    raw = env.split(":").filter(Boolean); // PATH-style, colon-separated
  } else if (file.chartsDir != null) {
    raw = Array.isArray(file.chartsDir) ? file.chartsDir : [file.chartsDir];
  } else {
    raw = defaultChartsDirs();
  }

  // Absolutise (so cwd surprises are impossible for configured paths) and dedupe.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of raw) {
    const abs = resolve(d);
    if (!seen.has(abs)) {
      seen.add(abs);
      out.push(abs);
    }
  }
  return out;
}

export function loadConfig(): HelperConfig {
  let file: RawFileConfig = {};
  const path = configPath();
  if (existsSync(path)) {
    try {
      file = JSON.parse(readFileSync(path, "utf8")) as RawFileConfig;
    } catch {
      // Malformed config — ignore and fall back to env / defaults.
    }
  }

  const envPort = Number(process.env.SINGIFY_PORT);
  return {
    usdbUser: process.env.SINGIFY_USDB_USER ?? file.usdbUser,
    usdbPass: process.env.SINGIFY_USDB_PASS ?? file.usdbPass,
    port: Number.isFinite(envPort) && envPort > 0 ? envPort : file.port ?? DEFAULT_PORT,
    cacheDir: process.env.SINGIFY_CACHE_DIR ?? file.cacheDir,
    chartsDirs: resolveChartsDirs(file),
  };
}
