/**
 * harness.tsx — browser dev harness for <KaraokeView>.
 *
 * Stubs the Spicetify global with a real React so karaoke-view.tsx runs
 * unchanged, parses a fixture chart, and drives it with a synthetic transport
 * clock (play / pause / seek / loop). No Spotify or Spicetify required.
 */

import * as React from "react";
import { createRoot } from "react-dom/client";

// Must exist before <KaraokeView> renders (it reads Spicetify.React at render).
(globalThis as unknown as { Spicetify: unknown }).Spicetify = {
  React,
  ReactDOM: {},
  Player: {},
};

import { parse } from "../src/ultrastar-parser";
import { KaraokeView } from "../src/karaoke-view";
import { FIXTURE_TXT } from "./fixture";

// ── Synthetic playback clock ─────────────────────────────────────────────────

let posMs = 0;
let anchor = performance.now();
let playing = false;

function getPositionMs(): number {
  return playing ? posMs + (performance.now() - anchor) : posMs;
}
function play(): void {
  if (playing) return;
  anchor = performance.now();
  playing = true;
}
function pause(): void {
  posMs = getPositionMs();
  playing = false;
}
function seek(ms: number): void {
  posMs = Math.max(0, ms);
  anchor = performance.now();
}

// ── Transport UI ─────────────────────────────────────────────────────────────

function fmt(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

// Optional deep-link: ?t=<ms> sets the initial position, ?play=1 autostarts.
const params = new URLSearchParams(location.search);
const initialT = Number(params.get("t") ?? 0);
if (initialT > 0) seek(initialT);
const autoplay = params.get("play") === "1";
if (autoplay) play();

function App() {
  const song = React.useMemo(() => parse(FIXTURE_TXT), []);
  const [isPlaying, setIsPlaying] = React.useState(autoplay);
  const [, force] = React.useState(0);
  const loopEnd = song.durationMs + 1500;

  React.useEffect(() => {
    let raf = 0;
    const tick = () => {
      if (getPositionMs() > loopEnd) seek(0);
      force((x) => (x + 1) % 1_000_000); // repaint transport each frame
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [loopEnd]);

  const toggle = () => {
    if (isPlaying) pause();
    else play();
    setIsPlaying(!isPlaying);
  };

  const pos = getPositionMs();

  return (
    <div style={{ maxWidth: 960, margin: "24px auto", padding: "0 16px" }}>
      <h2 style={{ color: "#fff", font: "600 18px system-ui", margin: "0 0 12px" }}>
        singify · KaraokeView harness
      </h2>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          marginBottom: 14,
          color: "#c8c8c8",
          font: "500 13px system-ui",
        }}
      >
        <button
          onClick={toggle}
          style={{
            background: "#1ed760",
            color: "#08210f",
            border: 0,
            borderRadius: 20,
            padding: "8px 18px",
            font: "700 13px system-ui",
            cursor: "pointer",
          }}
        >
          {isPlaying ? "Pause" : "Play"}
        </button>
        <button
          onClick={() => seek(0)}
          style={{
            background: "#2a2a33",
            color: "#fff",
            border: 0,
            borderRadius: 20,
            padding: "8px 14px",
            cursor: "pointer",
          }}
        >
          ⟲ Restart
        </button>
        <span style={{ fontVariantNumeric: "tabular-nums" }}>
          {fmt(pos)} / {fmt(song.durationMs)}
        </span>
        <input
          type="range"
          min={0}
          max={song.durationMs}
          value={Math.min(pos, song.durationMs)}
          onChange={(e) => seek(Number(e.target.value))}
          style={{ flex: 1 }}
        />
      </div>

      <div
        style={{
          height: 520,
          borderRadius: 14,
          overflow: "hidden",
          background: "linear-gradient(160deg, #14141c, #0c0c12)",
          border: "1px solid #23232c",
        }}
      >
        <KaraokeView song={song} getPositionMs={getPositionMs} />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
