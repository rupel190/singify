/**
 * scoring.ts — UltraStar-compatible scoring (pure core + stateful accumulator).
 *
 * The model (source-verified against USDX / UltraStar Play — see the project's
 * karaoke-scoring-rules notes):
 *
 *   total 10000 = 9000 note points + 1000 line bonus
 *
 * - Note points are shared across every scored note in proportion to its
 *   WEIGHT = durationBeats × ScoreFactor. ScoreFactor: normal 1, golden 2,
 *   freestyle 0 (never scored). So a long note is worth more than a short one,
 *   and a golden note is worth double a normal one of equal length — this is
 *   decided up front, before a note is sung.
 * - Each note then earns its max × (fraction of it sung on-pitch). "Fraction"
 *   is measured as hitFrames / totalFrames while the note is active, which
 *   approximates fraction-of-duration held correctly (silence counts against
 *   you, matching real engines).
 * - The 1000-point line bonus is split evenly across lines that contain scored
 *   notes, each line's share scaled by how well that line was sung.
 *
 * The hit test is OCTAVE-AGNOSTIC: the sung pitch is folded into the target
 * note's octave (foldToOctaveOf) and compared within a tolerance band that
 * shrinks with difficulty (easy ±2, medium ±1, hard ±0 semitones — USDX's
 * `Range := 2 - Level`). Folding modulo-12 also makes the comparison immune to
 * the constant (×12) offset between the chart's raw pitch numbers and MIDI.
 *
 * createScoreKeeper() is the only stateful part; it takes per-frame samples and
 * exposes the running score. It's still fully unit-testable by feeding a
 * scripted sequence of (ms, midi) readings — no microphone required.
 */

import { foldToOctaveOf } from "./pitch";
import type { ParsedSong, NoteType } from "./ultrastar-parser";

export type Difficulty = "easy" | "medium" | "hard";

/** Points multiplier per note type (freestyle is never scored). */
export const SCORE_FACTOR: Record<NoteType, number> = {
  normal: 1,
  golden: 2,
  freestyle: 0,
};

export const MAX_SCORE = 10000;
const NOTE_POINTS = 9000;
const LINE_BONUS = 1000;

/** Half-width of the hit band in semitones for a given difficulty. */
export function toleranceSemitones(difficulty: Difficulty): number {
  return difficulty === "easy" ? 2 : difficulty === "medium" ? 1 : 0;
}

export interface Grade {
  /** Named tier, shown big on the result screen. */
  name: string;
  /** 0..5, for a star row. */
  stars: number;
}

/**
 * Map a final score (0..MAX_SCORE) to a named rating tier. The bands are
 * approximate — tuned to feel like UltraStar's rating ladder, not a byte-exact
 * copy — and are deliberately easy to retune in one place.
 */
export function gradeForScore(total: number): Grade {
  if (total >= 9000) return { name: "Superstar", stars: 5 };
  if (total >= 7500) return { name: "Lead Singer", stars: 4 };
  if (total >= 6000) return { name: "Rising Star", stars: 3 };
  if (total >= 4000) return { name: "Hopeful", stars: 2 };
  if (total >= 2000) return { name: "Amateur", stars: 1 };
  return { name: "Tone Deaf", stars: 0 };
}

export interface ScoreState {
  /** Running total, 0..10000, rounded. */
  total: number;
  /** Portion from notes, 0..9000. */
  notePoints: number;
  /** Portion from the line bonus, 0..1000. */
  linePoints: number;
  /** Notes with any credit so far (for a simple hit/total readout). */
  notesSung: number;
  /** Total scored notes in the song. */
  notesTotal: number;
}

interface NoteAcc {
  pitch: number;
  weight: number; // durationBeats × ScoreFactor
  maxPoints: number; // beat/factor-weighted share of NOTE_POINTS
  lineIndex: number;
  startMs: number;
  endMs: number;
  hitFrames: number;
  totalFrames: number;
}

export interface ScoreKeeper {
  /** Feed one frame: the playback position and the sung pitch (MIDI or null). */
  sample(positionMs: number, sungMidi: number | null): void;
  /** Current running score. */
  read(): ScoreState;
  /** Clear all accumulated hits (start a fresh attempt). */
  reset(): void;
}

/**
 * Build a score keeper for a song. Difficulty sets the pitch tolerance.
 * The keeper is stateful; the heavy lifting (weights, per-note maxima) is
 * computed once here and never recomputed per frame.
 */
export function createScoreKeeper(
  song: ParsedSong,
  difficulty: Difficulty = "easy"
): ScoreKeeper {
  const tol = toleranceSemitones(difficulty);

  const notes: NoteAcc[] = [];
  let totalWeight = 0;
  const bonusLines = new Set<number>();

  song.lines.forEach((line, li) => {
    for (const s of line.syllables) {
      const factor = SCORE_FACTOR[s.type];
      const weight = s.durationBeats * factor;
      if (weight <= 0) continue; // freestyle / zero-length → not scored
      totalWeight += weight;
      bonusLines.add(li);
      notes.push({
        pitch: s.pitch,
        weight,
        maxPoints: 0, // filled once totalWeight is known
        lineIndex: li,
        startMs: s.startMs,
        endMs: s.startMs + s.durationMs,
        hitFrames: 0,
        totalFrames: 0,
      });
    }
  });

  for (const n of notes) {
    n.maxPoints = totalWeight > 0 ? (n.weight / totalWeight) * NOTE_POINTS : 0;
  }
  // Notes don't overlap within an UltraStar track; sort by start for lookup.
  notes.sort((a, b) => a.startMs - b.startMs);
  const nBonusLines = bonusLines.size;

  /** The scored note whose [start, end) contains `ms`, or null in a gap. */
  function activeNote(ms: number): NoteAcc | null {
    let lo = 0;
    let hi = notes.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const n = notes[mid];
      if (ms < n.startMs) hi = mid - 1;
      else if (ms >= n.endMs) lo = mid + 1;
      else return n;
    }
    return null;
  }

  function sample(positionMs: number, sungMidi: number | null): void {
    const n = activeNote(positionMs);
    if (!n) return; // outside every note — nothing to credit
    n.totalFrames++;
    if (sungMidi != null) {
      const folded = foldToOctaveOf(sungMidi, n.pitch, n.pitch);
      if (Math.abs(folded - n.pitch) <= tol) n.hitFrames++;
    }
  }

  function read(): ScoreState {
    let notePoints = 0;
    let notesSung = 0;
    const lineWeight = new Map<number, number>();
    const lineCredit = new Map<number, number>();

    for (const n of notes) {
      const f = n.totalFrames > 0 ? n.hitFrames / n.totalFrames : 0;
      notePoints += n.maxPoints * f;
      if (f > 0) notesSung++;
      lineWeight.set(n.lineIndex, (lineWeight.get(n.lineIndex) ?? 0) + n.weight);
      lineCredit.set(
        n.lineIndex,
        (lineCredit.get(n.lineIndex) ?? 0) + n.weight * f
      );
    }

    let linePoints = 0;
    if (nBonusLines > 0) {
      const perLine = LINE_BONUS / nBonusLines;
      for (const li of bonusLines) {
        const w = lineWeight.get(li) ?? 0;
        const credit = w > 0 ? (lineCredit.get(li) ?? 0) / w : 0;
        linePoints += perLine * credit;
      }
    }

    return {
      total: Math.round(notePoints + linePoints),
      notePoints: Math.round(notePoints),
      linePoints: Math.round(linePoints),
      notesSung,
      notesTotal: notes.length,
    };
  }

  function reset(): void {
    for (const n of notes) {
      n.hitFrames = 0;
      n.totalFrames = 0;
    }
  }

  return { sample, read, reset };
}
