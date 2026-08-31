/**
 * stats.ts — round history + aggregation (pure).
 *
 * A "round" is one scored song for one or more singers. We keep the raw list
 * (persisted via the helper to ~/.local/share/singify/stats.json) and derive the
 * views on demand, so new cuts of the data never need a migration.
 *
 * The point (per the ask): every player-entry carries the MIC it was sung on, so
 * `aggregateByMic` can answer "which mic actually performs better" across songs
 * and singers — not just which person scored highest.
 */

import type { Difficulty } from "./scoring";

/** One singer's result in one round, tagged with the gear they used. */
export interface StatPlayer {
  name: string;
  score: number; // 0..10000
  device: string; // resolved mic label, or "Default mic"
  gain: number;
  sensitivity: number;
}

/** One scored song. `t` is epoch ms at record time. */
export interface StatRound {
  t: number;
  title?: string;
  artist?: string;
  difficulty: Difficulty;
  players: StatPlayer[];
}

/** The on-disk shape of the stats store. */
export interface StatsDoc {
  rounds: StatRound[];
}

export interface MicAgg {
  device: string;
  rounds: number; // player-entries sung on this mic
  avg: number;
  best: number;
  bestSong?: string;
}

export interface PlayerAgg {
  name: string;
  rounds: number;
  avg: number;
  best: number;
}

function songLabel(r: StatRound): string {
  return (
    [r.artist, r.title].filter(Boolean).join(" — ") ||
    r.title ||
    r.artist ||
    "(unknown)"
  );
}

/** Per-mic aggregate, best average first — the "which mic wins" table. */
export function aggregateByMic(rounds: StatRound[]): MicAgg[] {
  const by = new Map<string, { sum: number; n: number; best: number; bestSong?: string }>();
  for (const r of rounds) {
    for (const p of r.players) {
      const key = p.device || "Default mic";
      const e = by.get(key) ?? { sum: 0, n: 0, best: -1 };
      e.sum += p.score;
      e.n += 1;
      if (p.score > e.best) {
        e.best = p.score;
        e.bestSong = songLabel(r);
      }
      by.set(key, e);
    }
  }
  return [...by.entries()]
    .map(([device, e]) => ({
      device,
      rounds: e.n,
      avg: Math.round(e.sum / e.n),
      best: Math.max(0, e.best),
      bestSong: e.bestSong,
    }))
    .sort((a, b) => b.avg - a.avg);
}

/** Per-singer aggregate, best average first. */
export function aggregateByPlayer(rounds: StatRound[]): PlayerAgg[] {
  const by = new Map<string, { sum: number; n: number; best: number }>();
  for (const r of rounds) {
    for (const p of r.players) {
      const e = by.get(p.name) ?? { sum: 0, n: 0, best: -1 };
      e.sum += p.score;
      e.n += 1;
      if (p.score > e.best) e.best = p.score;
      by.set(p.name, e);
    }
  }
  return [...by.entries()]
    .map(([name, e]) => ({
      name,
      rounds: e.n,
      avg: Math.round(e.sum / e.n),
      best: Math.max(0, e.best),
    }))
    .sort((a, b) => b.avg - a.avg);
}
