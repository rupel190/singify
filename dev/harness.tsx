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
import { SongPicker } from "../src/song-picker";
import { startMicPitch, type MicPitch } from "../src/mic";
import type { USDBSong } from "../src/usdb";
import { FIXTURE_TXT } from "./fixture";

// A few fake USDB candidates so the picker can be exercised without a live USDB.
// Picking FAIL_ID simulates a failed download, to show the error state.
const FAIL_ID = 99999;
const MOCK_CANDIDATES: USDBSong[] = [
  { id: 12345, artist: "Singify", title: "Harness Demo", edition: "SingStar", golden: true, language: "English", rating: 4.5, views: 8123 },
  { id: 12346, artist: "Singify", title: "Harness Demo (Radio Edit)", edition: "[SC]-Songs", golden: false, language: "English", rating: 3, views: 512 },
  { id: FAIL_ID, artist: "Singify feat. Chorus", title: "Harness Demo (Live)", edition: "", golden: false, language: "German", rating: 5, views: 20440 },
];

// ── Synthetic playback clock ─────────────────────────────────────────────────

const OFFSET_STEP = 20; // ms per nudge — matches the Spotify adapter

let posMs = 0;
let anchor = performance.now();
let playing = false;
let offsetMs = 0; // lyric-sync knob (ephemeral in the harness; persisted in Spotify)

// Base transport position, before the offset. Anchoring reads THIS, never the
// offset-adjusted value, so nudging the offset can't disturb playback.
function getBaseMs(): number {
  return playing ? posMs + (performance.now() - anchor) : posMs;
}
// What <KaraokeView> reads: base clock + user offset. Identical contract to the
// Spotify adapter's getCurrentMs — the view can't tell the two hosts apart.
function getPositionMs(): number {
  return getBaseMs() + offsetMs;
}
function play(): void {
  if (playing) return;
  anchor = performance.now();
  playing = true;
}
function pause(): void {
  posMs = getBaseMs();
  playing = false;
}
function seek(ms: number): void {
  posMs = Math.max(0, ms);
  anchor = performance.now();
}
function nudgeOffset(delta: number): void {
  offsetMs = Math.round(offsetMs + delta);
}
function resetOffset(): void {
  offsetMs = 0;
}

const stepBtn: React.CSSProperties = {
  background: "#2a2a33",
  color: "#fff",
  border: 0,
  borderRadius: 8,
  padding: "6px 10px",
  cursor: "pointer",
  font: "600 12px system-ui",
};

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
  const [song, setSong] = React.useState(() => parse(FIXTURE_TXT));
  const [songLabel, setSongLabel] = React.useState("built-in fixture");
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [isPlaying, setIsPlaying] = React.useState(autoplay);
  const [, force] = React.useState(0);
  const loopEnd = song.durationMs + 1500;

  // Load a real UltraStar .txt (file input or drag-drop). Parsing a real chart
  // is the point — it exercises the actual parser against RELATIVE mode, wide
  // pitch ranges, golden/freestyle notes and long durations the fixture lacks.
  const loadText = (text: string, label: string) => {
    try {
      const parsed = parse(text);
      if (parsed.lines.length === 0) throw new Error("no singable notes found");
      pause();
      seek(0);
      setIsPlaying(false);
      setSong(parsed);
      setSongLabel(`${parsed.headers.artist} – ${parsed.headers.title} (${label})`);
      setLoadError(null);
    } catch (e) {
      setLoadError(`Couldn't parse ${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const onFile = async (file?: File | null) => {
    if (file) loadText(await file.text(), file.name);
  };
  const revertFixture = () => {
    pause();
    seek(0);
    setIsPlaying(false);
    setSong(parse(FIXTURE_TXT));
    setSongLabel("built-in fixture");
    setLoadError(null);
  };

  const [mode, setMode] = React.useState<"karaoke" | "picker">("karaoke");
  const [pendingId, setPendingId] = React.useState<number | null>(null);
  const [pickError, setPickError] = React.useState<string | null>(null);

  const openPicker = () => {
    setPickError(null);
    setPendingId(null);
    setMode("picker");
  };
  const onCancel = () => {
    setPendingId(null);
    setPickError(null);
    setMode("karaoke");
  };
  // Stand-in for the USDB download the localhost helper will eventually perform.
  const onPick = (c: USDBSong) => {
    setPickError(null);
    setPendingId(c.id);
    setTimeout(() => {
      setPendingId(null);
      if (c.id === FAIL_ID) {
        setPickError(`Couldn't download “${c.title}” — USDB returned an error. Try another.`);
      } else {
        setMode("karaoke"); // pretend the chosen chart is now loaded (the fixture)
      }
    }, 1100);
  };

  const micRef = React.useRef<MicPitch | null>(null);
  const [micOn, setMicOn] = React.useState(false);
  const [micError, setMicError] = React.useState<string | null>(null);

  const toggleMic = async () => {
    if (micRef.current) {
      micRef.current.stop();
      micRef.current = null;
      setMicOn(false);
      return;
    }
    try {
      setMicError(null);
      micRef.current = await startMicPitch();
      setMicOn(true);
    } catch (e) {
      setMicError(e instanceof Error ? e.message : "Mic access denied");
      setMicOn(false);
    }
  };

  // Stable getter (reads the ref) so KaraokeView's frame loop isn't rebuilt.
  const getLivePitchMidi = React.useCallback(
    () => micRef.current?.read()?.midi ?? null,
    []
  );

  React.useEffect(() => {
    let raf = 0;
    const tick = () => {
      if (getBaseMs() > loopEnd) seek(0);
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

  const pos = getBaseMs(); // transport reflects real playback; offset only shifts the view

  return (
    <div style={{ maxWidth: 960, margin: "24px auto", padding: "0 16px" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          margin: "0 0 12px",
        }}
      >
        <h2 style={{ color: "#fff", font: "600 18px system-ui", margin: 0 }}>
          singify · {mode === "picker" ? "SongPicker" : "KaraokeView"} harness
        </h2>
        <button style={stepBtn} onClick={mode === "picker" ? onCancel : openPicker}>
          {mode === "picker" ? "← Back to karaoke" : "Picker demo →"}
        </button>
      </div>

      {mode === "karaoke" ? (
        <div>

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
        <button
          onClick={toggleMic}
          style={{
            background: micOn ? "#ff5ea8" : "#2a2a33",
            color: micOn ? "#2a0a18" : "#fff",
            border: 0,
            borderRadius: 20,
            padding: "8px 14px",
            font: "700 13px system-ui",
            cursor: "pointer",
          }}
        >
          {micOn ? "🎤 Mic on" : "🎤 Mic"}
        </button>
        {micError && (
          <span style={{ color: "#ff6b6b", fontSize: 12 }}>{micError}</span>
        )}
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

      {/* Offset knob — nudge the karaoke timeline against the (imagined) audio. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 14,
          color: "#c8c8c8",
          font: "500 13px system-ui",
        }}
      >
        <span style={{ opacity: 0.7 }}>Lyric offset</span>
        <button style={stepBtn} onClick={() => nudgeOffset(-OFFSET_STEP)}>
          −{OFFSET_STEP}
        </button>
        <span
          style={{ minWidth: 74, textAlign: "center", fontVariantNumeric: "tabular-nums" }}
        >
          {offsetMs > 0 ? "+" : ""}
          {offsetMs} ms
        </span>
        <button style={stepBtn} onClick={() => nudgeOffset(OFFSET_STEP)}>
          +{OFFSET_STEP}
        </button>
        <button style={stepBtn} onClick={resetOffset}>
          ⟲ reset
        </button>
        <span style={{ opacity: 0.5, marginLeft: 8, fontSize: 12 }}>
          positive = lyrics fire earlier
        </span>
      </div>

      {/* Chart loader — drop a real UltraStar .txt or pick one. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginBottom: 14,
          color: "#c8c8c8",
          font: "500 13px system-ui",
          flexWrap: "wrap",
        }}
      >
        <span style={{ opacity: 0.7 }}>Chart</span>
        <span style={{ color: "#fff", fontWeight: 600 }}>{songLabel}</span>
        <label style={{ ...stepBtn, display: "inline-block" }}>
          Load .txt…
          <input
            type="file"
            accept=".txt,text/plain"
            onChange={(e) => void onFile(e.target.files?.[0])}
            style={{ display: "none" }}
          />
        </label>
        {songLabel !== "built-in fixture" && (
          <button style={stepBtn} onClick={revertFixture}>
            ↺ fixture
          </button>
        )}
        <span style={{ opacity: 0.5, fontSize: 12 }}>…or drag a file onto the stage</span>
        {loadError && (
          <span style={{ color: "#ff6b6b", fontSize: 12, width: "100%" }}>{loadError}</span>
        )}
      </div>

      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          void onFile(e.dataTransfer.files?.[0]);
        }}
        style={{
          height: 520,
          borderRadius: 14,
          overflow: "hidden",
          background: "linear-gradient(160deg, #14141c, #0c0c12)",
          border: "1px solid #23232c",
        }}
      >
        <KaraokeView
          song={song}
          getPositionMs={getPositionMs}
          getLivePitchMidi={getLivePitchMidi}
          showScore={micOn}
          onReplay={() => {
            seek(0);
            play();
            setIsPlaying(true);
          }}
        />
      </div>
        </div>
      ) : (
        <div
          style={{
            height: 520,
            borderRadius: 14,
            overflow: "hidden",
            background: "linear-gradient(160deg, #14141c, #0c0c12)",
            border: "1px solid #23232c",
          }}
        >
          <SongPicker
            candidates={MOCK_CANDIDATES}
            query={{ artist: "Singify", title: "Harness Demo" }}
            pendingId={pendingId}
            error={pickError}
            onPick={onPick}
            onCancel={onCancel}
          />
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
