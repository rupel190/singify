/**
 * session.ts — multi-round session state (pure, host-agnostic).
 *
 * A session is N rounds; each round is one song played to the end while scoring.
 * The adapter owns playback/UI and feeds completed rounds in here; this module
 * just accumulates and aggregates. Kept free of Spicetify/React so the harness
 * can drive a whole session with synthetic completions.
 *
 * MULTIPLAYER-SHAPED: a round already holds a LIST of per-player scores (length
 * 1 today). When hotseat / multi-mic land, more entries slot in with no rewrite.
 */

import { gradeForScore, type Grade, type ScoreState } from "./scoring";

export const DEFAULT_PLAYER = "You";

/** One track in a playlist-sourced session's round list. */
export interface SessionTrack {
  uri: string; // Spotify track URI (round bookkeeping + playback)
  title: string;
  artist: string;
}

export interface PlayerScore {
  player: string;
  total: number;
  grade: Grade;
  notesSung: number;
  notesTotal: number;
}

export interface RoundResult {
  title: string;
  artist: string;
  scores: PlayerScore[]; // one per player
}

export interface Session {
  targetRounds: number;
  players: string[]; // ["You"] for now
  rounds: RoundResult[];
  /**
   * Ordered round source. When set, the session plays through these tracks in
   * order and its length fixes targetRounds. null/absent = follow-the-queue
   * (count mode): the adapter just advances the Spotify queue N times.
   */
  playlist?: SessionTrack[] | null;
  /** Display name of the source playlist, when playlist-sourced. */
  playlistName?: string | null;
}

export function createSession(
  targetRounds: number,
  players: string[] = [DEFAULT_PLAYER]
): Session {
  return {
    targetRounds: Math.max(1, Math.round(targetRounds)),
    players: players.length ? players : [DEFAULT_PLAYER],
    rounds: [],
    playlist: null,
    playlistName: null,
  };
}

/**
 * A session whose rounds ARE a playlist's tracks, played in order. The round
 * count is the track count — you sing the whole list. Empty lists clamp to a
 * 1-round session (the adapter shouldn't offer an empty playlist, but never
 * produce a 0-round session).
 */
export function createSessionFromPlaylist(
  name: string,
  tracks: SessionTrack[],
  players: string[] = [DEFAULT_PLAYER]
): Session {
  return {
    targetRounds: Math.max(1, tracks.length),
    players: players.length ? players : [DEFAULT_PLAYER],
    rounds: [],
    playlist: tracks.slice(),
    playlistName: name,
  };
}

/** True when the session's rounds come from a playlist (vs following the queue). */
export function isPlaylistSession(s: Session): boolean {
  return s.playlist != null && s.playlist.length > 0;
}

/**
 * The track queued for the NEXT round in a playlist session (indexed by rounds
 * already recorded), or null when following the queue or the list is spent.
 */
export function upNext(s: Session): SessionTrack | null {
  if (!s.playlist) return null;
  return s.playlist[s.rounds.length] ?? null;
}

/** Build a round result from a single-player ScoreState (the current mic). */
export function roundFromScore(
  title: string,
  artist: string,
  score: ScoreState,
  player: string = DEFAULT_PLAYER
): RoundResult {
  return {
    title,
    artist,
    scores: [
      {
        player,
        total: score.total,
        grade: gradeForScore(score.total),
        notesSung: score.notesSung,
        notesTotal: score.notesTotal,
      },
    ],
  };
}

/** Append a completed round (returns a new Session — never mutates). */
export function recordRound(s: Session, r: RoundResult): Session {
  return { ...s, rounds: [...s.rounds, r] };
}

export function roundsDone(s: Session): number {
  return s.rounds.length;
}

export function roundsLeft(s: Session): number {
  return Math.max(0, s.targetRounds - s.rounds.length);
}

export function isComplete(s: Session): boolean {
  return s.rounds.length >= s.targetRounds;
}

export interface PlayerSummary {
  player: string;
  total: number; // summed across rounds
  avg: number; // mean per round
  grade: Grade; // grade of the average
}

export interface SessionSummary {
  players: PlayerSummary[];
  rounds: RoundResult[];
  bestRound: { title: string; player: string; total: number } | null;
}

/** Aggregate a session: per-player totals + overall grade + the standout round. */
export function summarize(s: Session): SessionSummary {
  const players = s.players.map((player): PlayerSummary => {
    const totals = s.rounds.map(
      (r) => r.scores.find((x) => x.player === player)?.total ?? 0
    );
    const total = totals.reduce((a, b) => a + b, 0);
    const avg = totals.length ? Math.round(total / totals.length) : 0;
    return { player, total, avg, grade: gradeForScore(avg) };
  });

  let bestRound: SessionSummary["bestRound"] = null;
  for (const r of s.rounds) {
    for (const sc of r.scores) {
      if (!bestRound || sc.total > bestRound.total) {
        bestRound = { title: r.title, player: sc.player, total: sc.total };
      }
    }
  }

  return { players, rounds: s.rounds, bestRound };
}
