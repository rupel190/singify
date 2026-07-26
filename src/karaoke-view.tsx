/**
 * karaoke-view.tsx — the karaoke render surface.
 *
 * Two stacked views:
 *   - Pitch lane (top): a horizontal note highway, time flows left→right, a
 *     fixed "now" line at ~25% from the left. Notes are laid out once by
 *     absolute time and the whole track is translated each frame (cheap,
 *     GPU-composited) instead of re-rendering every note.
 *   - Lyric scroll (bottom): a small window of lines centred on the current
 *     line, with a per-syllable karaoke wipe on the active syllable.
 *
 * Driven by a requestAnimationFrame loop that reads getPositionMs() — the
 * caller owns the clock (interpolated from Spicetify in the app, synthetic in
 * the browser harness).
 *
 * Uses Spicetify.React so the same file runs unchanged inside Spotify and in
 * the harness (which assigns a real React onto Spicetify.React).
 */

import {
  getPosition,
  getPitchRange,
  targetPitchAt,
  type ParsedSong,
  type Syllable,
} from "./ultrastar-parser";
import { foldSmoothHit, createPitchSmoother } from "./pitch";
import { createScoreKeeper, gradeForScore, type ScoreState } from "./scoring";
import { ResultScreen } from "./result-screen";

/**
 * One active singer — the generalised "mic port". Solo/hotseat pass a single
 * entry; versus passes two. `getPitchMidi` must be a stable reference (the
 * frame loop reads it every frame); `color` tints this player's marker, trail
 * and score HUD so two singers stay visually distinct.
 */
export interface PlayerInput {
  id: string;
  name: string;
  color: string;
  getPitchMidi: () => number | null;
}

/** A player's final score for a round, handed to onComplete. */
export interface PlayerRoundScore {
  id: string;
  name: string;
  score: ScoreState;
}

export interface KaraokeViewProps {
  song: ParsedSong;
  /** Returns the current playback position in ms. Polled every frame. */
  getPositionMs: () => number;
  /**
   * Active singers, one mic each. Empty/undefined = play-along (no scoring, no
   * markers). One entry = solo / hotseat. Two = versus — two markers + two
   * score HUDs. Adding/removing a player starts a fresh scored attempt.
   */
  players?: PlayerInput[];
  /**
   * Called from the result screen's "Sing again" button. The host restarts the
   * track; the view resets its own score when playback jumps back to the start.
   */
  onReplay?: () => void;
  /**
   * Optional per-frame diagnostics for player 0 (dev harness overlay): the raw
   * detected pitch, the current target, and the smoothed marker.
   */
  onDebug?: (d: FrameDebug) => void;
  /**
   * Fired once when the song reaches its end while scoring, carrying every
   * player's final score. When provided, the view hands off (renders nothing at
   * the end) so a session host can record the round and advance; when absent
   * (solo Quick Sing), the view shows its own per-song ResultScreen.
   */
  onComplete?: (scores: PlayerRoundScore[]) => void;
  fullscreen?: boolean;
}

export interface FrameDebug {
  rawMidi: number | null;
  targetPitch: number | null;
  markerPitch: number | null;
  markerHit: boolean;
}

// Horizontal scale of the pitch lane: pixels per millisecond of song time.
const PX_PER_MS = 0.18;
// The "now" line sits this fraction from the left edge of the lane.
const NOW_FRACTION = 0.25;
const NOTE_HEIGHT = 14; // px
const LANE_VPAD = 24; // px of vertical padding inside the lane
const HIT_TOLERANCE = 2; // semitones — Easy (Medium=1, Hard=0 later)
const GUTTER = 120; // px — left axis reserved for pitch-name labels (Performous-style)
const TRAIL_MS = 850; // how far back (ms) the sung-pitch trail reaches
const TRAIL_MAX = 96; // ring-buffer cap (frames) — a safety bound on dot count

const COLORS = {
  laneBg: "rgba(0, 0, 0, 0.28)",
  nowLine: "#1ed760",
  noteNormal: "#4a78c2",
  noteGolden: "#e6b422",
  gridLine: "rgba(255, 255, 255, 0.06)",
  lyricDone: "#6d6d6d",
  lyricUpcoming: "#c8c8c8",
  lyricActive: "#ffffff",
  lyricWipe: "#1ed760",
  livePitch: "#ff5ea8",
  axisLabel: "rgba(255, 255, 255, 0.58)",
};

/**
 * Per-player marker/trail/HUD colours, assigned by index. Player 0 is the same
 * pink the solo marker always used, so a one-player session looks identical.
 */
export const PLAYER_COLORS = [COLORS.livePitch, "#3a86ff", "#e6b422", "#43d17a"];

// MIDI note number → name (60 = C4). Drives the left pitch axis.
const NOTE_NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
function midiToName(midi: number): string {
  const r = Math.round(midi);
  return NOTE_NAMES[((r % 12) + 12) % 12] + (Math.floor(r / 12) - 1);
}

/** Measure a ref's pixel size, updating on resize. */
function useSize(ref: { current: HTMLElement | null }): { w: number; h: number } {
  const { useState, useEffect } = Spicetify.React;
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref.current]);
  return size;
}

/** Per-player result for one frame (marker + running score). */
interface PlayerFrame {
  id: string;
  markerPitch: number | null; // folded + smoothed, ready to plot (target on a hit)
  markerHit: boolean;
  score: ScoreState | null;
}

interface FrameState {
  ms: number;
  players: PlayerFrame[]; // one per active singer, in input order
}

/**
 * Single rAF loop driving the view. Everything that must advance exactly once
 * per frame — each player's scoring + marker fold/smooth — happens inside
 * `computeFrame` (never in render, which React may run multiple times per
 * commit). The result is one state object, so there's one re-render per frame.
 */
function useFrame(
  getPositionMs: () => number,
  computeFrame: (ms: number) => FrameState
): FrameState {
  const { useState, useEffect, useRef } = Spicetify.React;
  const [frame, setFrame] = useState<FrameState>({ ms: 0, players: [] });
  const raf = useRef(0);
  useEffect(() => {
    const tick = () => {
      setFrame(computeFrame(getPositionMs()));
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [getPositionMs, computeFrame]);
  return frame;
}

/** One player's scoring engine: score keeper + marker smoother + sung trail. */
interface Engine {
  keeper: ReturnType<typeof createScoreKeeper>;
  smoother: ReturnType<typeof createPitchSmoother>;
  trail: { ms: number; pitch: number; hit: boolean }[];
}

export function KaraokeView(props: KaraokeViewProps) {
  const React = Spicetify.React;
  const { useRef, useMemo, useCallback, useEffect } = React;
  const { song, getPositionMs, onReplay, fullscreen } = props;

  // The active singers. Empty = play-along (no scoring); one = solo/hotseat;
  // two = versus. Memoised on identity so the frame loop isn't rebuilt each render.
  const players = useMemo(() => props.players ?? [], [props.players]);
  const scoring = players.length > 0;
  // Stable key for the roster (ids), so we reset engines when the set changes.
  const idsKey = players.map((p) => p.id).join("|");

  // One scoring engine per player, created lazily and reset per song / roster.
  const enginesRef = useRef<Map<string, Engine>>(new Map());
  const engineFor = useCallback(
    (id: string): Engine => {
      let e = enginesRef.current.get(id);
      if (!e) {
        e = { keeper: createScoreKeeper(song), smoother: createPitchSmoother(), trail: [] };
        enginesRef.current.set(id, e);
      }
      return e;
    },
    [song]
  );

  const lastMsRef = useRef(0);
  // Current players read via a ref so the rAF loop (keyed only on song) always
  // sees the latest roster + getters without being torn down and rebuilt.
  const playersRef = useRef(players);
  playersRef.current = players;
  // onDebug read via a ref so a changing callback identity never rebuilds the loop.
  const onDebugRef = useRef(props.onDebug);
  onDebugRef.current = props.onDebug;
  // Guards onComplete so it fires exactly once per attempt (reset on jump-back).
  const completedRef = useRef(false);

  // Fresh attempt whenever the song OR the roster changes: drop every engine so
  // scores/markers/trails start clean (turning a mic on = a fresh scored run).
  useEffect(() => {
    enginesRef.current.clear();
    lastMsRef.current = 0;
    completedRef.current = false;
  }, [song, idsKey]);

  // The one per-frame computation, run once per active player. Scoring samples
  // the RAW pitch; the marker folds the raw pitch to the target note FIRST, then
  // smooths (foldSmoothHit — order matters so octave flicker doesn't average
  // into garbage). Each player has its own engine (keeper/smoother/trail).
  const computeFrame = useCallback(
    (ms: number): FrameState => {
      const jumpedBack = ms < lastMsRef.current - 750; // restart / seek-back
      lastMsRef.current = ms;
      if (jumpedBack) completedRef.current = false; // a restart begins a fresh attempt

      const target = targetPitchAt(song, ms);
      const ps = playersRef.current;
      const out: PlayerFrame[] = [];

      for (let i = 0; i < ps.length; i++) {
        const p = ps[i];
        const eng = engineFor(p.id);
        if (jumpedBack) {
          eng.keeper.reset();
          eng.smoother.reset();
          eng.trail.length = 0;
        }
        const rawMidi = p.getPitchMidi();
        eng.keeper.sample(ms, rawMidi);
        const score = eng.keeper.read();

        const { pitch, hit } = foldSmoothHit(eng.smoother, rawMidi, target, HIT_TOLERANCE);
        if (pitch != null) {
          const buf = eng.trail;
          buf.push({ ms, pitch, hit });
          const cutoff = ms - TRAIL_MS;
          while (buf.length && buf[0].ms < cutoff) buf.shift();
          if (buf.length > TRAIL_MAX) buf.splice(0, buf.length - TRAIL_MAX);
        }
        // Diagnostics track player 0 only (the harness debug overlay).
        if (i === 0) {
          onDebugRef.current?.({ rawMidi, targetPitch: target, markerPitch: pitch, markerHit: hit });
        }
        out.push({ id: p.id, markerPitch: pitch, markerHit: hit, score });
      }
      return { ms, players: out };
    },
    [song, engineFor]
  );

  const frame = useFrame(getPositionMs, computeFrame);
  const positionMs = frame.ms;
  const laneRef = useRef<HTMLDivElement | null>(null);
  const lane = useSize(laneRef);

  const [minPitch, maxPitch] = useMemo(() => getPitchRange(song), [song]);
  const pitchSpan = Math.max(1, maxPitch - minPitch);
  const innerH = Math.max(NOTE_HEIGHT, lane.h - LANE_VPAD * 2);

  const yForPitch = (pitch: number): number => {
    const t = (pitch - minPitch) / pitchSpan; // 0..1, low..high
    return LANE_VPAD + (1 - t) * (innerH - NOTE_HEIGHT);
  };
  // Vertical centre of a note row (grid lines + axis labels align to this).
  const yCenterForPitch = (pitch: number): number => yForPitch(pitch) + NOTE_HEIGHT / 2;

  // Pitch-name axis labels — big, matched toward the lyric size.
  const axisLabelSize = 60;

  // Labelled pitch rows for the left axis. Cap the row count to what the lane
  // height can hold without the (now large) labels colliding — so the vertical
  // spacing stays comfortable on any screen size.
  const pitchRows = useMemo(() => {
    const lo = Math.floor(minPitch);
    const hi = Math.ceil(maxPitch);
    const span = Math.max(1, hi - lo);
    const maxRows = Math.max(2, Math.min(7, Math.floor(innerH / (axisLabelSize * 1.8))));
    const step = Math.max(1, Math.ceil(span / (maxRows - 1)));
    const rows: number[] = [];
    for (let m = lo; m <= hi; m += step) rows.push(m);
    return rows;
  }, [minPitch, maxPitch, innerH, axisLabelSize]);

  // Notes are positioned once by absolute time; only the track transform moves.
  const noteEls = useMemo(() => {
    const els: JSX.Element[] = [];
    let key = 0;
    for (const line of song.lines) {
      for (const s of line.syllables) {
        if (s.type === "freestyle") continue;
        els.push(
          <div
            key={key++}
            style={{
              position: "absolute",
              left: s.startMs * PX_PER_MS,
              width: Math.max(3, s.durationMs * PX_PER_MS - 2),
              top: yForPitch(s.pitch),
              height: NOTE_HEIGHT,
              borderRadius: NOTE_HEIGHT / 2,
              background: s.type === "golden" ? COLORS.noteGolden : COLORS.noteNormal,
              boxShadow:
                s.type === "golden" ? "0 0 8px rgba(230,180,34,0.6)" : "none",
            }}
          />
        );
      }
    }
    return els;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [song, lane.h, minPitch, maxPitch]);

  const nowX = lane.w * NOW_FRACTION;
  const trackTranslate = nowX - positionMs * PX_PER_MS;

  // Map a (folded, smoothed) pitch to its Y centre on the lane. The fold + smooth
  // + hit test already ran in computeFrame (USDX UNote.pas:548-571 style — fold
  // into the target note's octave so a rising interval reads as rising, then
  // snap on a hit); here we just place it.
  const yForMarker = (pitch: number): number =>
    LANE_VPAD +
    (1 - Math.min(1, Math.max(0, (pitch - minPitch) / pitchSpan))) *
      (innerH - NOTE_HEIGHT) +
    NOTE_HEIGHT / 2;

  // Zip the per-frame results back to their inputs (colour/name), in order.
  const rendered = frame.players
    .map((pf, i) => ({ ...pf, input: players[i] }))
    .filter((r) => r.input);

  // Once playback passes the song's end (and someone was scoring), the attempt
  // is done. Fire onComplete once with every player's score, then either hand
  // off to the host (session) or show the per-song result (solo Quick Sing).
  const anyScore = frame.players.some((p) => p.score != null);
  const atEnd = scoring && anyScore && song.durationMs > 0 && positionMs >= song.durationMs;

  useEffect(() => {
    if (atEnd && !completedRef.current) {
      completedRef.current = true;
      const scores: PlayerRoundScore[] = rendered
        .filter((r) => r.score != null)
        .map((r) => ({ id: r.id, name: r.input.name, score: r.score as ScoreState }));
      if (scores.length) props.onComplete?.(scores);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [atEnd]);

  if (atEnd) {
    if (props.onComplete) return null; // a session host takes over from here
    // Solo Quick Sing: show the one player's per-song result.
    const solo = frame.players[0];
    if (solo?.score) {
      return (
        <ResultScreen
          score={solo.score}
          grade={gradeForScore(solo.score.total)}
          title={song.headers.title}
          onReplay={onReplay}
          fullscreen={fullscreen}
        />
      );
    }
  }

  // ── Lyric window ──
  const pos = getPosition(song, positionMs);
  const lineIndex = pos.lineIndex < 0 ? 0 : pos.lineIndex;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: fullscreen ? "100vh" : "100%",
        minHeight: fullscreen ? "100vh" : 360,
        color: "#fff",
        fontFamily:
          "var(--font-family, 'Spotify Circular', system-ui, sans-serif)",
        gap: 12,
        // Extra headroom up top so the HUD + score readouts don't hug the edge;
        // it comes out of the note lane (flex:1), which can spare it.
        padding: fullscreen ? "52px 24px 20px" : 16,
        boxSizing: "border-box",
      }}
    >
      {/* ── Pitch lane ── */}
      <div
        ref={laneRef}
        style={{
          position: "relative",
          flex: "1 1 auto", // the note highway is the hero — it fills the stage
          minHeight: 160,
          overflow: "hidden",
          borderRadius: 10,
          background: COLORS.laneBg,
        }}
      >
        {/* pitch-name axis: a grid line + note label per row (Performous-style) */}
        {pitchRows.map((m) => {
          const y = yCenterForPitch(m);
          return (
            <div key={`row${m}`}>
              <div
                style={{
                  position: "absolute",
                  left: GUTTER,
                  right: 0,
                  top: y,
                  height: 1,
                  background: COLORS.gridLine,
                }}
              />
              <div
                style={{
                  position: "absolute",
                  left: 10,
                  top: y - axisLabelSize / 2,
                  fontSize: axisLabelSize,
                  fontWeight: 600,
                  lineHeight: 1,
                  color: COLORS.axisLabel,
                  fontVariantNumeric: "tabular-nums",
                  pointerEvents: "none",
                }}
              >
                {midiToName(m)}
              </div>
            </div>
          );
        })}
        {/* soft fade on the left so labels stay legible over scrolling notes/art */}
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: GUTTER + 20,
            background: `linear-gradient(to right, ${COLORS.laneBg}, transparent)`,
            pointerEvents: "none",
          }}
        />

        {/* moving note track */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            transform: `translateX(${trackTranslate}px)`,
            willChange: "transform",
          }}
        >
          {noteEls}
        </div>

        {/* fixed "now" line */}
        <div
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: nowX,
            width: 2,
            background: COLORS.nowLine,
            boxShadow: `0 0 10px ${COLORS.nowLine}`,
          }}
        />

        {/* sung-pitch trail, per player: recent samples pinned to the notes they
            were sung against (x = now-line offset by age), fading with age. Each
            player's dots take their own colour; a hit still flashes green. */}
        {rendered.map((r) => {
          const eng = enginesRef.current.get(r.id);
          if (!eng) return null;
          return eng.trail.map((p, i) => {
            const x = nowX + (p.ms - positionMs) * PX_PER_MS;
            if (x < GUTTER + 4) return null; // don't paint under the label gutter
            const o = Math.max(0, 1 - (positionMs - p.ms) / TRAIL_MS);
            const size = 3 + o * 3;
            const ty = yForMarker(p.pitch);
            return (
              <div
                key={`${r.id}-${i}`}
                style={{
                  position: "absolute",
                  left: x - size / 2,
                  top: ty - size / 2,
                  width: size,
                  height: size,
                  borderRadius: "50%",
                  background: p.hit ? COLORS.nowLine : r.input.color,
                  opacity: o * 0.75,
                  pointerEvents: "none",
                }}
              />
            );
          });
        })}

        {/* live sung-pitch marker per player. On a hit it goes green + pops
            bigger + glows brighter — the "you nailed it" feedback. */}
        {rendered.map((r) => {
          if (r.markerPitch == null) return null;
          const color = r.markerHit ? COLORS.nowLine : r.input.color;
          return (
            <div
              key={r.id}
              style={{
                position: "absolute",
                left: nowX - 9,
                top: yForMarker(r.markerPitch) - 9,
                width: 18,
                height: 18,
                borderRadius: "50%",
                background: color,
                boxShadow: r.markerHit
                  ? `0 0 22px ${color}, 0 0 9px ${color}`
                  : `0 0 12px ${color}`,
                transform: r.markerHit ? "scale(1.3)" : "scale(1)",
                transition:
                  "top 60ms linear, transform 110ms ease, box-shadow 110ms ease, background 90ms ease",
                pointerEvents: "none",
                zIndex: 3,
              }}
            />
          );
        })}

        {/* running score HUD per player — player 0 top-right, player 1 top-left,
            each tinted its colour; the name shows only in multiplayer. */}
        {rendered.map((r, i) =>
          r.score ? (
            <div
              key={r.id}
              style={{
                position: "absolute",
                top: 8,
                [i === 0 ? "right" : "left"]: 12,
                textAlign: i === 0 ? "right" : "left",
                fontVariantNumeric: "tabular-nums",
                pointerEvents: "none",
              }}
            >
              {rendered.length > 1 && (
                <div style={{ fontSize: 22, fontWeight: 800, color: r.input.color, lineHeight: 1 }}>
                  {r.input.name}
                </div>
              )}
              <div
                style={{
                  fontSize: 80,
                  fontWeight: 800,
                  lineHeight: 1,
                  color: rendered.length > 1 ? r.input.color : COLORS.nowLine,
                  textShadow: "0 1px 6px rgba(0,0,0,0.5)",
                }}
              >
                {r.score.total.toLocaleString()}
              </div>
              <div style={{ marginTop: 6, fontSize: 24, fontWeight: 600, color: "rgba(255,255,255,0.55)" }}>
                {r.score.notesSung}/{r.score.notesTotal} notes
              </div>
            </div>
          ) : null
        )}
      </div>

      {/* ── Lyric band (anchored at the bottom, like SingStar/UltraStar) ── */}
      <div
        style={{
          flex: "0 0 auto",
          display: "flex",
          flexDirection: "column",
          justifyContent: "flex-end",
          alignItems: "center",
          gap: fullscreen ? 14 : 8,
          textAlign: "center",
          overflow: "hidden",
          paddingTop: fullscreen ? 28 : 16,
          paddingBottom: fullscreen ? 28 : 12,
          background: "linear-gradient(to bottom, transparent, rgba(0,0,0,0.30))",
        }}
      >
        {[-1, 0, 1, 2].map((offset) => {
          const idx = lineIndex + offset;
          const line = song.lines[idx];
          if (!line) return <div key={offset} style={{ minHeight: 8 }} />;
          const isCurrent = offset === 0;
          return (
            <LyricLine
              key={idx}
              line={line}
              isCurrent={isCurrent}
              positionMs={positionMs}
            />
          );
        })}
      </div>
    </div>
  );
}

function LyricLine(props: {
  line: import("./ultrastar-parser").Line;
  isCurrent: boolean;
  positionMs: number;
}) {
  const React = Spicetify.React;
  const { line, isCurrent, positionMs } = props;

  const baseSize = 84;
  const size = isCurrent ? baseSize : baseSize * 0.6;

  return (
    <div
      style={{
        fontSize: size,
        fontWeight: isCurrent ? 700 : 500,
        lineHeight: 1.15,
        opacity: isCurrent ? 1 : 0.5,
        transition: "opacity 120ms ease, font-size 120ms ease",
        whiteSpace: "pre-wrap",
      }}
    >
      {line.syllables.map((s, i) => (
        <SyllableSpan key={i} syllable={s} positionMs={positionMs} active={isCurrent} />
      ))}
    </div>
  );
}

function SyllableSpan(props: {
  syllable: Syllable;
  positionMs: number;
  active: boolean;
}) {
  const React = Spicetify.React;
  const { syllable: s, positionMs, active } = props;
  const end = s.startMs + s.durationMs;
  // Some charts write held/melisma syllables with "~" (e.g. "co~ffee"); it's a
  // note-continuation marker, not text — strip it for display.
  const text = s.text.replace(/~/g, "");

  let color = COLORS.lyricUpcoming;
  let backgroundImage: string | undefined;
  let scale = 1;

  if (active) {
    if (positionMs >= end) {
      color = COLORS.lyricDone;
    } else if (positionMs >= s.startMs) {
      // karaoke wipe: fill left→right over the syllable's duration
      const frac = Math.min(1, Math.max(0, (positionMs - s.startMs) / s.durationMs));
      const pct = Math.round(frac * 100);
      color = "transparent";
      backgroundImage = `linear-gradient(90deg, ${COLORS.lyricWipe} ${pct}%, ${COLORS.lyricActive} ${pct}%)`;
      scale = 1.08;
    }
  }

  return (
    <span
      style={{
        color,
        backgroundImage,
        WebkitBackgroundClip: backgroundImage ? "text" : undefined,
        backgroundClip: backgroundImage ? "text" : undefined,
        display: "inline-block",
        transform: `scale(${scale})`,
        transformOrigin: "center bottom",
        transition: "transform 90ms ease",
      }}
    >
      {text}
    </span>
  );
}
