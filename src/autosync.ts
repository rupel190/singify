/**
 * autosync.ts — find a chart's offset from Spotify's own line-synced lyrics.
 *
 * Same problem as subtitle sync (alass / ffsubsync): the chart was timed against
 * one copy of the song, Spotify plays another. Spotify's lyrics are timed to the
 * exact master that's playing, so they are the reference.
 *
 *   1. Flatten both sides to word sequences (the chart has a time per syllable,
 *      so per word; Spotify only per line).
 *   2. Align the words in order (Needleman–Wunsch, free end gaps) so the third
 *      chorus pairs with the third chorus, not the first.
 *   3. Every Spotify line whose opening words align gives an anchor:
 *      offset = chart time of that word − Spotify line start.
 *   4. Fit the anchors: constant (one offset), drift (the chart's tempo is off,
 *      so the offset slides linearly), or step (the chart has a section the
 *      recording doesn't, so the offset jumps).
 *
 * Offset convention matches the app: chart time = Spotify position + offset.
 * Pure — no Spicetify, no DOM — so it's tested against real charts directly.
 */

import type { ParsedSong } from "./ultrastar-parser";

/** One Spotify lyric line: when it starts and what it says. */
export interface LyricLine {
  startMs: number;
  words: string;
}

export interface Anchor {
  spotifyMs: number; // Spotify line start
  offsetMs: number; // chart time − Spotify time at that line
}

export type SyncShape = "constant" | "drift" | "step" | "noisy";

/** A piecewise-linear offset curve: offset at a Spotify time, held flat past the ends. */
export interface OffsetKnot {
  atMs: number;
  offsetMs: number;
}

export interface SyncResult {
  anchors: Anchor[];
  /** Fraction of Spotify's lines that produced an anchor. */
  coverage: number;
  /** Median offset — the single best constant. Raw: no bias correction. */
  offsetMs: number;
  /** Median absolute deviation of anchors from the median offset. */
  spreadMs: number;
  /** Fraction of anchors within ±500 ms of the median. */
  within500: number;
  shape: SyncShape;
  /** Offset change per ms of song (drift slope); 0.027 = the chart runs 2.7 % slow. */
  slope: number;
  /** The offset over the song, for drift/step charts (else a single knot). */
  curve: OffsetKnot[];
}

// ── Text ──────────────────────────────────────────────────────────────────────

/** Lowercase, fold accents/umlauts, drop punctuation and UltraStar markers. */
export function normalizeWord(w: string): string {
  return w
    .toLowerCase()
    .replace(/ß/g, "ss")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

interface TimedWord {
  w: string;
  ms: number;
}

/** The chart as words, each timed at its first syllable. A word ends at a space. */
export function chartWords(song: ParsedSong): TimedWord[] {
  const out: TimedWord[] = [];
  for (const line of song.lines) {
    let cur = "";
    let curMs = 0;
    const flush = () => {
      const w = normalizeWord(cur);
      if (w) out.push({ w, ms: curMs });
      cur = "";
    };
    for (const s of line.syllables) {
      const text = s.text.replace(/~/g, "");
      if (/^\s/.test(text)) flush();
      if (!cur.trim()) curMs = s.startMs;
      for (const part of text.split(/(\s+)/)) {
        if (!part) continue;
        if (/^\s+$/.test(part)) flush();
        else {
          if (!cur.trim()) curMs = s.startMs;
          cur += part;
        }
      }
    }
    flush(); // a line ends a word
  }
  return out;
}

/** Spotify's lines as words, tagged with their line. Blank and ♪ lines drop out. */
function lyricWords(lines: LyricLine[]): { w: string; line: number }[] {
  const out: { w: string; line: number }[] = [];
  lines.forEach((l, i) => {
    for (const raw of l.words.split(/\s+/)) {
      const w = normalizeWord(raw);
      if (w) out.push({ w, line: i });
    }
  });
  return out;
}

/** Edit similarity in 0..1 (1 = identical). */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const n = a.length;
  const m = b.length;
  if (!n || !m) return 0;
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    const cur = [i];
    for (let j = 1; j <= m; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return 1 - prev[m] / Math.max(n, m);
}

/**
 * Order-preserving word alignment, free at both ends (a chart may start or end
 * mid-lyric). Returns pairs [indexInA, indexInB] for words judged the same.
 */
export function alignWords(a: string[], b: string[]): [number, number][] {
  const n = a.length;
  const m = b.length;
  const GAP = -1;
  const score = (x: string, y: string) => (x === y ? 2 : similarity(x, y) >= 0.75 ? 1 : -1);
  const H = new Float64Array((n + 1) * (m + 1));
  const T = new Uint8Array((n + 1) * (m + 1)); // 1 diag, 2 up (skip a), 3 left (skip b)
  const at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = 1; i <= n; i++) T[at(i, 0)] = 2; // free leading gaps: H stays 0
  for (let j = 1; j <= m; j++) T[at(0, j)] = 3;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const d = H[at(i - 1, j - 1)] + score(a[i - 1], b[j - 1]);
      const u = H[at(i - 1, j)] + GAP;
      const l = H[at(i, j - 1)] + GAP;
      if (d >= u && d >= l) {
        H[at(i, j)] = d;
        T[at(i, j)] = 1;
      } else if (u >= l) {
        H[at(i, j)] = u;
        T[at(i, j)] = 2;
      } else {
        H[at(i, j)] = l;
        T[at(i, j)] = 3;
      }
    }
  }
  // Free trailing gaps: start the traceback from the best cell on the last row/column.
  let bi = n;
  let bj = m;
  let best = H[at(n, m)];
  for (let i = 0; i <= n; i++) if (H[at(i, m)] > best) [best, bi, bj] = [H[at(i, m)], i, m];
  for (let j = 0; j <= m; j++) if (H[at(n, j)] > best) [best, bi, bj] = [H[at(n, j)], n, j];

  const pairs: [number, number][] = [];
  let i = bi;
  let j = bj;
  while (i > 0 && j > 0) {
    const t = T[at(i, j)];
    if (t === 1) {
      if (score(a[i - 1], b[j - 1]) > 0) pairs.push([i - 1, j - 1]);
      i--;
      j--;
    } else if (t === 2) i--;
    else j--;
  }
  return pairs.reverse();
}

// ── Statistics ────────────────────────────────────────────────────────────────

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Robust line fit (Theil–Sen): offset ≈ intercept + slope · spotifyMs. */
function theilSen(anchors: Anchor[]): { slope: number; intercept: number } {
  const slopes: number[] = [];
  for (let i = 0; i < anchors.length; i++) {
    for (let j = i + 1; j < anchors.length; j++) {
      const dt = anchors[j].spotifyMs - anchors[i].spotifyMs;
      if (dt > 0) slopes.push((anchors[j].offsetMs - anchors[i].offsetMs) / dt);
    }
  }
  const slope = median(slopes);
  const intercept = median(anchors.map((a) => a.offsetMs - slope * a.spotifyMs));
  return { slope, intercept };
}

/** Runs of consecutive anchors that sit at one level (within ±500 ms of the run). */
function levelRuns(anchors: Anchor[]): Anchor[][] {
  const runs: Anchor[][] = [];
  for (const a of anchors) {
    const run = runs[runs.length - 1];
    if (run && Math.abs(a.offsetMs - median(run.map((r) => r.offsetMs))) <= 500) run.push(a);
    else runs.push([a]);
  }
  return runs.filter((r) => r.length >= 4);
}

// ── Main ──────────────────────────────────────────────────────────────────────

/** Anchor the chart against Spotify's lyrics and classify the offset's shape. */
export function autoSync(song: ParsedSong, lines: LyricLine[]): SyncResult | null {
  const cw = chartWords(song);
  const lw = lyricWords(lines);
  if (cw.length < 8 || lw.length < 8) return null;

  const pairs = alignWords(
    cw.map((x) => x.w),
    lw.map((x) => x.w)
  );
  const chartIdxOf = new Map<number, number>(pairs.map(([c, l]) => [l, c]));

  // A line anchors when its first word aligned and most of the next words did too.
  const anchors: Anchor[] = [];
  let first = 0;
  while (first < lw.length) {
    const line = lw[first].line;
    let end = first;
    while (end < lw.length && lw[end].line === line) end++;
    const c = chartIdxOf.get(first);
    const next = Math.min(3, end - first - 1);
    let aligned = 0;
    for (let k = 1; k <= next; k++) if (chartIdxOf.has(first + k)) aligned++;
    if (c != null && next >= 1 && aligned >= Math.min(2, next)) {
      anchors.push({ spotifyMs: lines[line].startMs, offsetMs: cw[c].ms - lines[line].startMs });
    }
    first = end;
  }
  const sungLines = new Set(lw.map((x) => x.line)).size;
  if (anchors.length === 0) return null;

  const offsetMs = median(anchors.map((a) => a.offsetMs));
  const spreadMs = median(anchors.map((a) => Math.abs(a.offsetMs - offsetMs)));
  const within500 = anchors.filter((a) => Math.abs(a.offsetMs - offsetMs) <= 500).length / anchors.length;
  const { slope, intercept } = theilSen(anchors);
  const t0 = anchors[0].spotifyMs;
  const t1 = anchors[anchors.length - 1].spotifyMs;
  const drift = Math.abs(slope * (t1 - t0));
  const residual = median(anchors.map((a) => Math.abs(a.offsetMs - (intercept + slope * a.spotifyMs))));

  // Order matters: a drift also looks like a staircase of "steps", so test the
  // straight-line fit before looking for level runs.
  let shape: SyncShape = "noisy";
  let curve: OffsetKnot[] = [{ atMs: 0, offsetMs }];
  const runs = levelRuns(anchors);
  const levels = runs.map((r) => median(r.map((a) => a.offsetMs)));
  if (spreadMs <= 200 && drift < 1000) shape = "constant";
  else if (residual <= 250 && drift >= 1000) {
    shape = "drift";
    curve = [
      { atMs: t0, offsetMs: intercept + slope * t0 },
      { atMs: t1, offsetMs: intercept + slope * t1 },
    ];
  } else if (runs.length >= 2 && Math.max(...levels) - Math.min(...levels) > 1500) {
    shape = "step";
    // Hold each run's level across it; the change happens in the gap between runs.
    curve = runs.flatMap((r, k) => [
      { atMs: r[0].spotifyMs, offsetMs: levels[k] },
      { atMs: r[r.length - 1].spotifyMs, offsetMs: levels[k] },
    ]);
  }

  return {
    anchors,
    coverage: sungLines ? anchors.length / sungLines : 0,
    offsetMs,
    spreadMs,
    within500,
    shape,
    slope,
    curve,
  };
}

/** Offset at a Spotify time on a curve: linear between knots, flat past the ends. */
export function offsetAt(curve: OffsetKnot[], atMs: number): number {
  if (!curve.length) return 0;
  if (atMs <= curve[0].atMs) return curve[0].offsetMs;
  for (let i = 1; i < curve.length; i++) {
    const a = curve[i - 1];
    const b = curve[i];
    if (atMs <= b.atMs) {
      const span = b.atMs - a.atMs;
      return span > 0 ? a.offsetMs + ((atMs - a.atMs) / span) * (b.offsetMs - a.offsetMs) : b.offsetMs;
    }
  }
  return curve[curve.length - 1].offsetMs;
}

/** Enough evidence to SUGGEST a single offset (the agents' tested gate). */
export function isConfident(r: SyncResult): boolean {
  return (
    r.shape === "constant" &&
    r.anchors.length >= 8 &&
    r.coverage >= 0.5 &&
    r.spreadMs <= 200 &&
    r.within500 >= 0.8
  );
}

/** Enough evidence that the chart doesn't fit this recording with one offset. */
export function isMismatch(r: SyncResult): boolean {
  return (r.shape === "drift" || r.shape === "step") && r.anchors.length >= 8 && r.coverage >= 0.4;
}

/** The fixed bias found on 44 tracks: estimates run ~333 ms above hand punches. */
export const DEFAULT_SYNC_BIAS_MS = 333;
