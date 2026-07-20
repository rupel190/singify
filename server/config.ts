/**
 * config.ts — helper configuration.
 *
 * Reads ~/.config/spicetify-karaoke/config.json, with environment-variable
 * overrides (handy for dev without writing a file). All fields optional; the
 * server still starts without credentials (so /health works and the user gets
 * a clear message) — it just can't reach USDB until they're set.
 *
 *   { "usdbUser": "...", "usdbPass": "...", "port": 4455, "cacheDir": "..." }
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";

export interface HelperConfig {
  usdbUser?: string;
  usdbPass?: string;
  port: number;
  cacheDir?: string;
}

export const DEFAULT_PORT = 4455;

export function configPath(): string {
  return join(homedir(), ".config", "spicetify-karaoke", "config.json");
}

export function loadConfig(): HelperConfig {
  let file: Partial<HelperConfig> = {};
  const path = configPath();
  if (existsSync(path)) {
    try {
      file = JSON.parse(readFileSync(path, "utf8")) as Partial<HelperConfig>;
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
  };
}
