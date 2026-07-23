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

export interface KaraokeViewProps {
  song: ParsedSong;
  /** Returns the current playback position in ms. Polled every frame. */
  getPositionMs: () => number;
  /**
   * Optional: returns the singer's current pitch as a (fractional) MIDI note,
   * or null when there's none. Polled every frame; drives the live-pitch marker.
   * Must be a stable reference (memoise it) so the frame loop isn't rebuilt.
   */
  getLivePitchMidi?: () => number | null;
  /**
   * When true, the running score accumulates and a score HUD is shown. The host
   * sets this (typically = "mic is active"); flipping it true starts a fresh
   * attempt. Scoring counts silence during a note as a miss, so it should only
   * run once the singer is actually being listened to.
   */
  showScore?: boolean;
  /**
   * Called from the result screen's "Sing again" button. The host restarts the
   * track; the view resets its own score when playback jumps back to the start.
   */
  onReplay?: () => void;
  /**
   * Optional per-frame diagnostics (dev harness overlay). Fires once per frame
   * with the raw detected pitch, the current target, and the smoothed marker —
   * so you can watch raw jitter vs the steadied marker on a real mic.
   */
  onDebug?: (d: FrameDebug) => void;
  /**
   * Fired once when the song reaches its end while scoring, carrying the final
   * score. When provided, the view hands off (renders nothing at the end) so a
   * session host can record the round and advance; when absent, the view shows
   * its own per-song ResultScreen (Quick Sing).
   */
  onComplete?: (score: ScoreState) => void;
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

interface FrameState {
  ms: number;
  markerPitch: number | null; // folded + smoothed, ready to plot (target on a hit)
  markerHit: boolean;
  score: ScoreState | null;
}

/**
 * Single rAF loop driving the view. Everything that must advance exactly once
 * per frame — scoring, the marker's fold+smooth — happens inside `computeFrame`
 * (never in render, which React may run multiple times per commit). The result
 * is one state object, so there's one re-render per frame.
 */
function useFrame(
  getPositionMs: () => number,
  getLivePitchMidi: (() => number | null) | undefined,
  computeFrame: (ms: number, rawMidi: number | null) => FrameState
): FrameState {
  const { useState, useEffect, useRef } = Spicetify.React;
  const [frame, setFrame] = useState<FrameState>({
    ms: 0,
    markerPitch: null,
    markerHit: false,
    score: null,
  });
  const raf = useRef(0);
  useEffect(() => {
    const tick = () => {
      const ms = getPositionMs();
      const raw = getLivePitchMidi ? getLivePitchMidi() : null;
      setFrame(computeFrame(ms, raw));
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [getPositionMs, getLivePitchMidi, computeFrame]);
  return frame;
}

export function KaraokeView(props: KaraokeViewProps) {
  const React = Spicetify.React;
  const { useRef, useMemo, useCallback, useEffect } = React;
  const { song, getPositionMs, getLivePitchMidi, showScore, onReplay, fullscreen } =
    props;

  // One score keeper + one marker smoother per song.
  const keeper = useMemo(() => createScoreKeeper(song), [song]);
  const smoother = useMemo(() => createPitchSmoother(), [song]);
  const showScoreRef = useRef(!!showScore);
  const lastMsRef = useRef(0);
  // Ring buffer of recent sung-pitch samples, drawn as a fading trail leading
  // into the now-line. Mutated once per frame in computeFrame; read in render.
  const trailRef = useRef<{ ms: number; pitch: number; hit: boolean }[]>([]);
  // onDebug read via a ref so a changing callback identity never rebuilds the
  // frame loop (which would restart the rAF each render).
  const onDebugRef = useRef(props.onDebug);
  onDebugRef.current = props.onDebug;
  // Guards onComplete so it fires exactly once per attempt (reset on jump-back).
  const completedRef = useRef(false);
  useEffect(() => {
    showScoreRef.current = !!showScore;
    if (showScore) {
      keeper.reset(); // flipping on starts a fresh attempt
      lastMsRef.current = 0;
    }
  }, [showScore, keeper]);

  // A new song is a fresh attempt — clear the one-shot completion guard so the
  // next song in a session can fire onComplete (seek-back alone isn't enough).
  useEffect(() => {
    completedRef.current = false;
  }, [song]);

  // The one per-frame computation. Scoring samples the RAW pitch; the marker
  // folds the raw pitch to the target note FIRST, then smooths (foldSmoothHit —
  // order matters so octave flicker doesn't average into garbage).
  const computeFrame = useCallback(
    (ms: number, rawMidi: number | null): FrameState => {
      const jumpedBack = ms < lastMsRef.current - 750; // restart / seek-back
      lastMsRef.current = ms;
      if (jumpedBack) {
        smoother.reset();
        trailRef.current = [];
        completedRef.current = false; // a restart begins a fresh attempt
      }

      let score: ScoreState | null = null;
      if (showScoreRef.current) {
        if (jumpedBack) keeper.reset();
        keeper.sample(ms, rawMidi);
        score = keeper.read();
      }

      const target = targetPitchAt(song, ms);
      const { pitch, hit } = foldSmoothHit(smoother, rawMidi, target, HIT_TOLERANCE);
      // Record the sample for the trail, then drop anything older than the window.
      if (pitch != null) {
        const buf = trailRef.current;
        buf.push({ ms, pitch, hit });
        const cutoff = ms - TRAIL_MS;
        while (buf.length && buf[0].ms < cutoff) buf.shift();
        if (buf.length > TRAIL_MAX) buf.splice(0, buf.length - TRAIL_MAX);
      }
      onDebugRef.current?.({ rawMidi, targetPitch: target, markerPitch: pitch, markerHit: hit });
      return { ms, markerPitch: pitch, markerHit: hit, score };
    },
    [keeper, smoother, song]
  );

  const { ms: positionMs, markerPitch, markerHit, score } = useFrame(
    getPositionMs,
    getLivePitchMidi,
    computeFrame
  );
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

  // Live sung-pitch marker. The fold-to-target + smooth + hit test already ran
  // once in computeFrame (USDX UNote.pas:548-571 style — fold into the target
  // note's octave so a rising interval reads as rising, then snap on a hit);
  // here we just map the resulting pitch to a Y and colour it.
  const markerColor = markerHit ? COLORS.nowLine : COLORS.livePitch;
  const liveY =
    markerPitch == null
      ? null
      : LANE_VPAD +
        (1 - Math.min(1, Math.max(0, (markerPitch - minPitch) / pitchSpan))) *
          (innerH - NOTE_HEIGHT) +
        NOTE_HEIGHT / 2;

  // Once playback passes the song's end (and we were scoring), the attempt is
  // done. Fire onComplete once (session hook), then either hand off to the host
  // (session) or show the per-song result (Quick Sing).
  const atEnd =
    showScore && score != null && song.durationMs > 0 && positionMs >= song.durationMs;

  useEffect(() => {
    if (atEnd && score && !completedRef.current) {
      completedRef.current = true;
      props.onComplete?.(score);
    }
  }, [atEnd, score]);

  if (atEnd && score) {
    if (props.onComplete) return null; // a session host takes over from here
    return (
      <ResultScreen
        score={score}
        grade={gradeForScore(score.total)}
        title={song.headers.title}
        onReplay={onReplay}
        fullscreen={fullscreen}
      />
    );
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
        padding: 16,
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

        {/* sung-pitch trail: recent samples pinned to the notes they were sung
            against (x = now-line offset by age), fading + shrinking with age. */}
        {trailRef.current.map((p, i) => {
          const x = nowX + (p.ms - positionMs) * PX_PER_MS;
          if (x < GUTTER + 4) return null; // don't paint under the label gutter
          const ty =
            LANE_VPAD +
            (1 - Math.min(1, Math.max(0, (p.pitch - minPitch) / pitchSpan))) *
              (innerH - NOTE_HEIGHT) +
            NOTE_HEIGHT / 2;
          const o = Math.max(0, 1 - (positionMs - p.ms) / TRAIL_MS);
          const size = 3 + o * 3;
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
                background: p.hit ? COLORS.nowLine : COLORS.livePitch,
                opacity: o * 0.75,
                pointerEvents: "none",
              }}
            />
          );
        })}

        {/* live sung-pitch marker (only when a mic pitch is available). On a hit
            it pops bigger + glows brighter — the "you nailed it" feedback. */}
        {liveY != null && (
          <div
            style={{
              position: "absolute",
              left: nowX - 9,
              top: liveY - 9,
              width: 18,
              height: 18,
              borderRadius: "50%",
              background: markerColor,
              boxShadow: markerHit
                ? `0 0 22px ${markerColor}, 0 0 9px ${markerColor}`
                : `0 0 12px ${markerColor}`,
              transform: markerHit ? "scale(1.3)" : "scale(1)",
              transition:
                "top 60ms linear, transform 110ms ease, box-shadow 110ms ease, background 90ms ease",
              pointerEvents: "none",
              zIndex: 3,
            }}
          />
        )}

        {/* running score HUD (only while scoring is active) */}
        {showScore && score && (
          <div
            style={{
              position: "absolute",
              top: 8,
              right: 12,
              textAlign: "right",
              fontVariantNumeric: "tabular-nums",
              pointerEvents: "none",
            }}
          >
            <div
              style={{
                fontSize: 80,
                fontWeight: 800,
                lineHeight: 1,
                color: COLORS.nowLine,
                textShadow: "0 1px 6px rgba(0,0,0,0.5)",
              }}
            >
              {score.total.toLocaleString()}
            </div>
            <div
              style={{
                marginTop: 6,
                fontSize: 24,
                fontWeight: 600,
                color: "rgba(255,255,255,0.55)",
              }}
            >
              {score.notesSung}/{score.notesTotal} notes
            </div>
          </div>
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
