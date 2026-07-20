/**
 * result-screen.tsx — end-of-song score summary.
 *
 * Presentational only: it's handed the final ScoreState + Grade and renders the
 * rating, the total, and the note/line breakdown. The shared KaraokeView shows
 * it once playback passes the song's end (while scoring is active); the host
 * wires `onReplay` to restart the track. Reads Spicetify.React so it runs
 * unchanged in Spotify and in the browser harness.
 */

import type { ScoreState, Grade } from "./scoring";

export interface ResultScreenProps {
  score: ScoreState;
  grade: Grade;
  title?: string;
  onReplay?: () => void;
  fullscreen?: boolean;
}

const ACCENT = "#1ed760";

export function ResultScreen(props: ResultScreenProps) {
  const React = Spicetify.React;
  const { score, grade, title, onReplay, fullscreen } = props;

  const bigSize = fullscreen ? 96 : 64;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        width: "100%",
        height: fullscreen ? "100vh" : "100%",
        minHeight: fullscreen ? "100vh" : 360,
        gap: 10,
        color: "#fff",
        fontFamily:
          "var(--font-family, 'Spotify Circular', system-ui, sans-serif)",
        padding: 24,
        boxSizing: "border-box",
        textAlign: "center",
      }}
    >
      {title && (
        <div style={{ fontSize: 14, letterSpacing: 1, opacity: 0.6 }}>
          {title.toUpperCase()}
        </div>
      )}

      {/* Star rating */}
      <div style={{ fontSize: fullscreen ? 34 : 26, letterSpacing: 4 }}>
        {Array.from({ length: 5 }).map((_, i) => (
          <span key={i} style={{ color: i < grade.stars ? "#e6b422" : "#3a3a44" }}>
            ★
          </span>
        ))}
      </div>

      {/* Named tier */}
      <div style={{ fontSize: fullscreen ? 40 : 30, fontWeight: 800, color: ACCENT }}>
        {grade.name}
      </div>

      {/* Total */}
      <div
        style={{
          fontSize: bigSize,
          fontWeight: 900,
          lineHeight: 1,
          fontVariantNumeric: "tabular-nums",
          textShadow: "0 2px 18px rgba(30,215,96,0.25)",
        }}
      >
        {score.total.toLocaleString()}
      </div>

      {/* Breakdown */}
      <div
        style={{
          display: "flex",
          gap: 24,
          marginTop: 6,
          fontSize: 13,
          color: "rgba(255,255,255,0.6)",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        <span>Notes {score.notePoints.toLocaleString()} / 9,000</span>
        <span>Line bonus {score.linePoints.toLocaleString()} / 1,000</span>
        <span>
          {score.notesSung} / {score.notesTotal} notes hit
        </span>
      </div>

      {onReplay && (
        <button
          onClick={onReplay}
          style={{
            marginTop: 22,
            background: ACCENT,
            color: "#08210f",
            border: 0,
            borderRadius: 22,
            padding: "10px 26px",
            font: "700 14px system-ui",
            cursor: "pointer",
          }}
        >
          Sing again
        </button>
      )}
    </div>
  );
}
