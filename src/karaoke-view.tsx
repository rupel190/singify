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
import { foldToOctaveOf, createPitchSmoother } from "./pitch";
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
  fullscreen?: boolean;
}

// Horizontal scale of the pitch lane: pixels per millisecond of song time.
const PX_PER_MS = 0.18;
// The "now" line sits this fraction from the left edge of the lane.
const NOW_FRACTION = 0.25;
const NOTE_HEIGHT = 14; // px
const LANE_VPAD = 24; // px of vertical padding inside the lane

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
};

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

/**
 * Single rAF loop driving the view: returns the playback position (ms) and the
 * live sung pitch (MIDI or null) as one state object, so there's one re-render
 * per frame rather than two.
 */
function useFrame(
  getPositionMs: () => number,
  getLivePitchMidi?: () => number | null,
  sample?: (ms: number, midi: number | null) => ScoreState | null,
  smooth?: (midi: number | null) => number | null
): { ms: number; midi: number | null; score: ScoreState | null } {
  const { useState, useEffect, useRef } = Spicetify.React;
  const [frame, setFrame] = useState<{
    ms: number;
    midi: number | null;
    score: ScoreState | null;
  }>({ ms: 0, midi: null, score: null });
  const raf = useRef(0);
  useEffect(() => {
    const tick = () => {
      const ms = getPositionMs();
      const raw = getLivePitchMidi ? getLivePitchMidi() : null;
      // Scoring sees the RAW pitch; only the displayed marker is smoothed.
      const score = sample ? sample(ms, raw) : null;
      const midi = smooth ? smooth(raw) : raw;
      setFrame({ ms, midi, score });
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [getPositionMs, getLivePitchMidi, sample, smooth]);
  return frame;
}

export function KaraokeView(props: KaraokeViewProps) {
  const React = Spicetify.React;
  const { useRef, useMemo, useCallback, useEffect } = React;
  const { song, getPositionMs, getLivePitchMidi, showScore, onReplay, fullscreen } =
    props;

  // Scoring: one keeper per song. A stable `sample` closure (so useFrame's
  // effect isn't rebuilt every render) feeds it frames only while scoring is
  // active, and returns the running score for the HUD.
  const keeper = useMemo(() => createScoreKeeper(song), [song]);
  const showScoreRef = useRef(!!showScore);
  const lastMsRef = useRef(0);
  useEffect(() => {
    showScoreRef.current = !!showScore;
    if (showScore) {
      keeper.reset(); // flipping on starts a fresh attempt
      lastMsRef.current = 0;
    }
  }, [showScore, keeper]);
  const sample = useCallback(
    (ms: number, midi: number | null): ScoreState | null => {
      if (!showScoreRef.current) return null;
      // A big backward jump (restart / "Sing again" / seek-back) starts over.
      if (ms < lastMsRef.current - 750) keeper.reset();
      lastMsRef.current = ms;
      keeper.sample(ms, midi);
      return keeper.read();
    },
    [keeper]
  );

  // Marker smoothing (display only — never the score). One smoother instance,
  // fed the raw pitch each frame via a stable closure.
  const smoother = useMemo(() => createPitchSmoother(), []);
  const smooth = useCallback(
    (midi: number | null): number | null => smoother.push(midi),
    [smoother]
  );

  const { ms: positionMs, midi: liveMidi, score } = useFrame(
    getPositionMs,
    getLivePitchMidi,
    sample,
    smooth
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

  // Live sung-pitch marker, placed the way real karaoke engines do it
  // (USDX UNote.pas:548-571): fold the sung pitch into the CURRENT TARGET note's
  // octave — not a global range — so a rising interval reads as rising instead
  // of collapsing by pitch class. On a hit, snap onto the target and colour it
  // like the "now" line for feedback.
  const HIT_TOLERANCE = 2; // semitones — Easy; later Medium=1, Hard=0
  const targetPitch = targetPitchAt(song, positionMs);
  let markerPitch: number | null = null;
  let markerHit = false;
  if (liveMidi != null && targetPitch != null) {
    const folded = foldToOctaveOf(liveMidi, targetPitch, targetPitch);
    markerHit = Math.abs(folded - targetPitch) <= HIT_TOLERANCE;
    markerPitch = markerHit ? targetPitch : folded;
  }
  const markerColor = markerHit ? COLORS.nowLine : COLORS.livePitch;
  const liveY =
    markerPitch == null
      ? null
      : LANE_VPAD +
        (1 - Math.min(1, Math.max(0, (markerPitch - minPitch) / pitchSpan))) *
          (innerH - NOTE_HEIGHT) +
        NOTE_HEIGHT / 2;

  // Once playback passes the song's end (and we were scoring), freeze the run
  // and show the result. In the harness this appears in the tail before the
  // loop restarts; the backward-jump reset above then starts the next attempt.
  if (showScore && score && song.durationMs > 0 && positionMs >= song.durationMs) {
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
          flex: fullscreen ? "1 1 auto" : "0 0 46%",
          minHeight: 160,
          overflow: "hidden",
          borderRadius: 10,
          background: COLORS.laneBg,
        }}
      >
        {/* pitch grid lines */}
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={`g${i}`}
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              top: LANE_VPAD + (i / 4) * (innerH - NOTE_HEIGHT),
              height: 1,
              background: COLORS.gridLine,
            }}
          />
        ))}

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

        {/* live sung-pitch marker (only when a mic pitch is available) */}
        {liveY != null && (
          <div
            style={{
              position: "absolute",
              left: nowX - 8,
              top: liveY - 8,
              width: 16,
              height: 16,
              borderRadius: "50%",
              background: markerColor,
              boxShadow: `0 0 12px ${markerColor}`,
              transition: "top 60ms linear, background 90ms ease",
              pointerEvents: "none",
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
                fontSize: fullscreen ? 40 : 28,
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
                marginTop: 2,
                fontSize: 11,
                fontWeight: 600,
                color: "rgba(255,255,255,0.55)",
              }}
            >
              {score.notesSung}/{score.notesTotal} notes
            </div>
          </div>
        )}
      </div>

      {/* ── Lyric scroll ── */}
      <div
        style={{
          flex: "1 1 auto",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "center",
          gap: fullscreen ? 18 : 10,
          textAlign: "center",
          overflow: "hidden",
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
              fullscreen={!!fullscreen}
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
  fullscreen: boolean;
}) {
  const React = Spicetify.React;
  const { line, isCurrent, positionMs, fullscreen } = props;

  const baseSize = fullscreen ? 34 : 22;
  const size = isCurrent ? baseSize : baseSize * 0.62;

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
      {s.text}
    </span>
  );
}
