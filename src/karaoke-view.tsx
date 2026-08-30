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
import {
  createScoreKeeper,
  gradeForScore,
  toleranceSemitones,
  type ScoreState,
  type Difficulty,
} from "./scoring";
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
  /**
   * Bump to start a fresh scored attempt WITHOUT changing the song or the
   * roster — the host's "reset scores" control. Every player's engine is
   * dropped, exactly as a new song or a changed roster would do it.
   */
  resetToken?: number;
  /**
   * Pitch tolerance for BOTH scoring and the visual hit-snap: easy ±2, medium
   * ±1, hard ±0 semitones. Default "easy". Changing it starts a fresh attempt.
   */
  difficulty?: Difficulty;
  /**
   * Cosmetic pixel nudge for the green hit-LINE ONLY (default 0). Slides just the
   * line left/right so it visually lines up with where a note meets the marker;
   * markers, notes and timing are untouched. NOT a sync control — the lyric
   * offset owns timing.
   */
  nowLineNudge?: number;
  fullscreen?: boolean;
}

export interface FrameDebug {
  rawMidi: number | null;
  targetPitch: number | null;
  markerPitch: number | null;
  markerHit: boolean;
}

// The "now" line sits this fraction from the left edge of the lane.
const NOW_FRACTION = 0.25;
// Horizontal scale is DERIVED from the measured lane, never hardcoded: what
// should hold constant between a laptop and a 4K TV is how many seconds of song
// are visible ahead of the now-line — so the zoom follows the width, not the
// other way round. A fixed px/ms tuned on a 1200px lane draws 36px syllables on
// a 3800px one, which is what made the chart read as scattered dashes.
const LOOKAHEAD_MS = 4000; // seconds of song visible right of the now-line
const FALLBACK_PX_PER_MS = 0.18; // only until the lane has been measured once
// Vertical layout. A semitone gets AT MOST this many pixels: uncapped, the
// song's range is stretched to fill whatever height the lane has, so a tall
// panel flings a modest melody from floor to ceiling. Capping the spacing and
// centring the used band keeps the melody reading as a line. Note thickness
// follows the row spacing, so bars are as fat as they can be without merging.
const MAX_PX_PER_SEMITONE = 58;
const NOTE_FILL = 0.9; // note thickness as a fraction of its semitone row
const MAX_NOTE_HEIGHT = 66;
const MIN_NOTE_HEIGHT = 10;
const LANE_VPAD = 24; // px of vertical padding inside the lane
// Pitch hit-band is now DERIVED from props.difficulty (toleranceSemitones),
// synced between scoring and the visual snap. This is the easy-mode value.
// Pitch-name axis label: 60 is the CAP for a full-height solo lane. Stacked
// lanes are shorter, so each Lane scales its own label size down from this (and
// derives its gutter from that), so the names don't dwarf the tiny note bars.
const AXIS_LABEL_MAX = 40;
const TRAIL_MS = 850; // how far back (ms) the sung-pitch trail reaches
const TRAIL_MAX = 96; // ring-buffer cap (frames) — a safety bound on dot count
// Marker and trail are sized as MULTIPLES of the note height rather than in
// fixed px, so they stay in proportion when the lane geometry changes — the
// live marker reads a little fatter than the note it is chasing.
const MARKER_SCALE = 1.6;
const TRAIL_DOT_MIN = 0.35; // oldest sample in the trail
const TRAIL_DOT_MAX = 0.7; // newest

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
// Slot 2 is violet, NOT gold — gold is reserved for golden notes (in every
// lane), so a gold player colour would blend its own golden notes.
export const PLAYER_COLORS = [COLORS.livePitch, "#3a86ff", "#a05cff", "#43d17a"];

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

/**
 * Inject the gold-shimmer keyframes once. A metallic highlight sweeps across
 * golden notes via an animated background-position — pure CSS, no canvas/WebGL
 * (kind to the GPU). Idempotent; safe to call every render.
 */
function ensureGoldShimmer(): void {
  if (typeof document === "undefined" || document.getElementById("singify-gold-shimmer")) return;
  const st = document.createElement("style");
  st.id = "singify-gold-shimmer";
  st.textContent =
    "@keyframes singify-gold-shimmer{from{background-position:220% 0}to{background-position:-20% 0}}";
  document.head.appendChild(st);
}

/** Scale a #rrggbb colour's brightness (f<1 darkens, f>1 lightens), clamped. */
function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * f)));
  return `rgb(${c((n >> 16) & 255)}, ${c((n >> 8) & 255)}, ${c(n & 255)})`;
}

/**
 * One player's note highway — a self-measuring row. Versus stacks several (one
 * per singer); solo / play-along renders exactly one. Each Lane owns its OWN
 * geometry (measured from its own height), so stacked rows each size their notes
 * to the space they got. All lanes share the song + clock, so notes scroll in
 * lockstep; only the marker/trail/score differ per player.
 */
function Lane(props: {
  song: ParsedSong;
  positionMs: number;
  nowLineNudge: number;
  player: { id: string; name: string; color: string } | null;
  markerPitch: number | null;
  markerHit: boolean;
  score: ScoreState | null;
  trail: { ms: number; pitch: number; hit: boolean }[];
  multiplayer: boolean;
}) {
  const React = Spicetify.React;
  const { useRef, useMemo } = React;
  const { song, positionMs, nowLineNudge, player, markerPitch, markerHit, score, trail, multiplayer } =
    props;

  const laneRef = useRef<HTMLDivElement | null>(null);
  const lane = useSize(laneRef);

  const [minPitch, maxPitch] = useMemo(() => getPitchRange(song), [song]);
  const pitchSpan = Math.max(1, maxPitch - minPitch);
  const innerH = Math.max(MIN_NOTE_HEIGHT, lane.h - LANE_VPAD * 2);

  const pxPerSemi = Math.min(MAX_PX_PER_SEMITONE, innerH / (pitchSpan + 1));
  const noteH = Math.max(MIN_NOTE_HEIGHT, Math.min(MAX_NOTE_HEIGHT, Math.round(pxPerSemi * NOTE_FILL)));
  const bandH = pxPerSemi * pitchSpan;
  const bandTop = LANE_VPAD + Math.max(0, (innerH - bandH - noteH) / 2);
  // Axis label + gutter scale with THIS lane's height, so a short stacked lane
  // gets small labels instead of the full-height 60px (which dwarfed the bars).
  const labelSize = Math.max(13, Math.min(AXIS_LABEL_MAX, Math.round(lane.h * 0.13)));
  const gutter = 12 + Math.round(labelSize * 2.6);
  const pxPerMs = lane.w > 0 ? (lane.w * (1 - NOW_FRACTION)) / LOOKAHEAD_MS : FALLBACK_PX_PER_MS;

  const yForPitch = (pitch: number): number => bandTop + (1 - (pitch - minPitch) / pitchSpan) * bandH;
  const yCenterForPitch = (pitch: number): number => yForPitch(pitch) + noteH / 2;
  const yForMarker = (pitch: number): number =>
    bandTop + (1 - Math.min(1, Math.max(0, (pitch - minPitch) / pitchSpan))) * bandH + noteH / 2;

  const pitchRows = useMemo(() => {
    const lo = Math.floor(minPitch);
    const hi = Math.ceil(maxPitch);
    const span = Math.max(1, hi - lo);
    const maxRows = Math.max(2, Math.min(7, Math.floor(bandH / (labelSize * 1.8))));
    const step = Math.max(1, Math.ceil(span / (maxRows - 1)));
    const rows: number[] = [];
    for (let m = lo; m <= hi; m += step) rows.push(m);
    return rows;
  }, [minPitch, maxPitch, bandH, labelSize]);

  // SingStar model: the target notes take a MUTED shade of the player's colour
  // (so each lane reads as that singer's), and the live marker below is the
  // BRIGHT, white-ringed indicator that reads on top of any of them. Golden
  // notes stay gold — a universal "worth double" signal, not per-player.
  const noteTint = player ? shade(player.color, 0.66) : COLORS.noteNormal;
  const noteEls = useMemo(() => {
    const els: JSX.Element[] = [];
    let key = 0;
    for (const line of song.lines) {
      for (const sy of line.syllables) {
        if (sy.type === "freestyle") continue;
        els.push(
          <div
            key={key++}
            style={{
              position: "absolute",
              left: sy.startMs * pxPerMs,
              width: Math.max(3, sy.durationMs * pxPerMs - 2),
              top: yForPitch(sy.pitch),
              height: noteH,
              borderRadius: noteH / 2,
              ...(sy.type === "golden"
                ? {
                    background:
                      "linear-gradient(100deg, #9a6f14 0%, #e6b422 26%, #fff4bf 50%, #e6b422 74%, #9a6f14 100%)",
                    backgroundSize: "220% 100%",
                    animation: "singify-gold-shimmer 2.4s linear infinite",
                    boxShadow: "0 0 12px rgba(230,180,34,0.7)",
                  }
                : { background: noteTint }),
            }}
          />
        );
      }
    }
    return els;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [song, lane.h, lane.w, minPitch, maxPitch, noteTint]);

  const nowX = lane.w * NOW_FRACTION;
  const trackTranslate = nowX - positionMs * pxPerMs;
  const markerColor = markerHit ? COLORS.nowLine : player?.color ?? COLORS.livePitch;
  const markerSize = Math.round(noteH * MARKER_SCALE);

  return (
    <div
      ref={laneRef}
      style={{ position: "relative", flex: "1 1 0", minHeight: 0, overflow: "hidden", borderRadius: 10, background: COLORS.laneBg }}
    >
      {pitchRows.map((m) => {
        const y = yCenterForPitch(m);
        return (
          <div key={`row${m}`}>
            <div style={{ position: "absolute", left: gutter, right: 0, top: y, height: 1, background: COLORS.gridLine }} />
            <div
              style={{
                position: "absolute",
                left: 10,
                top: y - labelSize / 2,
                fontSize: labelSize,
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
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          bottom: 0,
          width: gutter + 20,
          background: `linear-gradient(to right, ${COLORS.laneBg}, transparent)`,
          pointerEvents: "none",
        }}
      />
      <div style={{ position: "absolute", inset: 0, transform: `translateX(${trackTranslate}px)`, willChange: "transform" }}>
        {noteEls}
      </div>
      <div style={{ position: "absolute", top: 0, bottom: 0, left: nowX + nowLineNudge, width: 3, background: COLORS.nowLine, boxShadow: `0 0 10px ${COLORS.nowLine}` }} />
      {trail.map((pt, i) => {
        const x = nowX + (pt.ms - positionMs) * pxPerMs;
        if (x < gutter + 4) return null;
        const o = Math.max(0, 1 - (positionMs - pt.ms) / TRAIL_MS);
        const size = noteH * (TRAIL_DOT_MIN + o * (TRAIL_DOT_MAX - TRAIL_DOT_MIN));
        const ty = yForMarker(pt.pitch);
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: x - size / 2,
              top: ty - size / 2,
              width: size,
              height: size,
              borderRadius: "50%",
              background: pt.hit ? COLORS.nowLine : player?.color ?? COLORS.livePitch,
              opacity: o * 0.75,
              pointerEvents: "none",
            }}
          />
        );
      })}
      {markerPitch != null && (
        <div
          style={{
            position: "absolute",
            left: nowX - markerSize / 2,
            top: yForMarker(markerPitch) - markerSize / 2,
            width: markerSize,
            height: markerSize,
            borderRadius: "50%",
            boxSizing: "border-box",
            background: markerColor,
            // White ring + dark rim so the indicator reads on ANY note colour —
            // its own tinted lane included. On a hit it also pops + glows green.
            border: `${Math.max(2, Math.round(markerSize * 0.14))}px solid #fff`,
            boxShadow: markerHit
              ? `0 0 ${markerSize * 1.3}px ${markerColor}, 0 0 ${markerSize / 2}px ${markerColor}, 0 0 0 2px rgba(0,0,0,0.55)`
              : `0 0 ${markerSize * 0.8}px ${markerColor}, 0 0 0 2px rgba(0,0,0,0.55)`,
            transform: markerHit ? "scale(1.32)" : "scale(1)",
            transition: "top 60ms linear, transform 110ms ease, box-shadow 110ms ease, background 90ms ease",
            pointerEvents: "none",
            zIndex: 3,
          }}
        />
      )}
      {score && (
        <div
          style={{
            position: "absolute",
            bottom: 10,
            left: gutter + 16,
            textAlign: "left",
            fontVariantNumeric: "tabular-nums",
            pointerEvents: "none",
          }}
        >
          {multiplayer && player && (
            <div style={{ fontSize: 40, fontWeight: 800, color: player.color, lineHeight: 1 }}>{player.name}</div>
          )}
          <div
            style={{
              fontSize: 66,
              fontWeight: 800,
              lineHeight: 1,
              color: multiplayer && player ? player.color : COLORS.nowLine,
              textShadow: "0 1px 6px rgba(0,0,0,0.5)",
            }}
          >
            {score.total.toLocaleString()}
          </div>
          <div style={{ marginTop: 6, fontSize: 42, fontWeight: 600, color: "rgba(255,255,255,0.55)" }}>
            {score.notesSung}/{score.notesTotal} notes
          </div>
        </div>
      )}
    </div>
  );
}

export function KaraokeView(props: KaraokeViewProps) {
  const React = Spicetify.React;
  const { useRef, useMemo, useCallback, useEffect } = React;
  const { song, getPositionMs, onReplay, fullscreen } = props;
  const difficulty: Difficulty = props.difficulty ?? "easy";
  const nowLineNudge = props.nowLineNudge ?? 0;
  // Read via refs so the rAF loop and engineFor keep stable identities — only the
  // reset effect (below) reacts to a difficulty change, rebuilding the engines.
  const difficultyRef = useRef(difficulty);
  difficultyRef.current = difficulty;
  const hitTolRef = useRef(toleranceSemitones(difficulty));
  hitTolRef.current = toleranceSemitones(difficulty);

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
        e = {
          keeper: createScoreKeeper(song, difficultyRef.current),
          smoother: createPitchSmoother(),
          trail: [],
        };
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
  useEffect(() => ensureGoldShimmer(), []);

  useEffect(() => {
    enginesRef.current.clear();
    lastMsRef.current = 0;
    completedRef.current = false;
  }, [song, idsKey, props.resetToken, difficulty]);

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

        const { pitch, hit } = foldSmoothHit(eng.smoother, rawMidi, target, hitTolRef.current);
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


  // Zip the per-frame results back to their inputs (colour/name), in order.
  const rendered = frame.players
    .map((pf, i) => ({ ...pf, input: players[i] }))
    .filter((r) => r.input);

  // One lane per singer; play-along (no players) still shows one empty highway,
  // so `null` marks that placeholder row.
  const laneEntries: (typeof rendered[number] | null)[] =
    rendered.length > 0 ? rendered : [null];

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
        height: "100%",
        minHeight: fullscreen ? "100%" : 360,
        color: "#fff",
        fontFamily:
          "var(--font-family, 'Spotify Circular', system-ui, sans-serif)",
        gap: 12,
        // Headroom up top (clears Spotify's window chrome); the note highway then
        // takes the FULL display width. It used to be capped at 1200px "to stay
        // glanceable", but on a 4K panel that spent 30% of the screen and made
        // every element read tiny — the cap was the reason things needed scaling.
        padding: fullscreen ? "56px 28px 24px" : 16,
        boxSizing: "border-box",
      }}
    >
      {/* ── Pitch lanes ──
          One stacked highway per singer (versus); solo / play-along is a single
          row. The growing box fills 75% of its space, bottom-aligned, leaving
          headroom up top for the mic banner. Each Lane measures itself, so N
          rows each size their notes to the height they got. */}
      <div style={{ flex: "1 1 auto", minHeight: 0, display: "flex", flexDirection: "column", justifyContent: "flex-end" }}>
        <div
          style={{
            height: "75%",
            minHeight: 160,
            display: "flex",
            flexDirection: "column",
          }}
        >
          {laneEntries.flatMap((e, i) => {
            const lane = (
              <Lane
                key={e?.id ?? `lane${i}`}
                song={song}
                positionMs={positionMs}
                nowLineNudge={nowLineNudge}
                player={e ? { id: e.id, name: e.input.name, color: e.input.color } : null}
                markerPitch={e?.markerPitch ?? null}
                markerHit={e?.markerHit ?? false}
                score={e?.score ?? null}
                trail={e ? enginesRef.current.get(e.id)?.trail ?? [] : []}
                multiplayer={laneEntries.length > 1}
              />
            );
            if (i === 0) return [lane];
            // A slim, edge-fading divider between adjacent singers' lanes.
            const divider = (
              <div
                key={`div${i}`}
                style={{
                  flex: "0 0 auto",
                  height: 3,
                  margin: "7px 0",
                  borderRadius: 2,
                  background:
                    "linear-gradient(90deg, transparent, rgba(255,255,255,0.32), transparent)",
                }}
              />
            );
            return [divider, lane];
          })}
        </div>
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
