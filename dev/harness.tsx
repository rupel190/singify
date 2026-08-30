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

import { parse, targetPitchAt } from "../src/ultrastar-parser";
import {
  KaraokeView,
  PLAYER_COLORS,
  type FrameDebug,
  type PlayerInput,
} from "../src/karaoke-view";
import { SongPicker } from "../src/song-picker";
import {
  SessionSetup,
  SessionHud,
  MicOverlay,
  NowPlaying,
  NoChartInSession,
  SessionResultScreen,
  type PlayerSlot,
} from "../src/session-view";
import type { PlaylistRef } from "../src/playlist-source";
import { UI_SCALE } from "../src/ui-scale";
import {
  createSession,
  recordRound,
  roundFromScore,
  summarize,
} from "../src/session";
import type { ScoreState } from "../src/scoring";
import { startMicPitch, type MicPitch, type AppliedProcessing } from "../src/mic";
import { sensitivityToThreshold } from "../src/pitch";

const SENS_KEY = "singify:sensitivity";
function loadSensitivity(): number {
  const v = Number(localStorage.getItem(SENS_KEY));
  return Number.isFinite(v) && v >= 0 && v <= 100 ? v : 60;
}

// Note-name helpers for the diagnostic overlay.
const NOTE_LETTERS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
function noteName(midi: number | null): string {
  if (midi == null) return "—";
  const r = Math.round(midi);
  return `${NOTE_LETTERS[((r % 12) + 12) % 12]}${Math.floor(r / 12) - 1}`;
}
function pcLetter(midi: number | null): string {
  if (midi == null) return "—";
  return NOTE_LETTERS[((Math.round(midi) % 12) + 12) % 12];
}
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

/** Input level bar with the sensitivity gate marked (pink). Green past the gate. */
function LevelMeter(props: { level: number; threshold: number }) {
  const METER_MAX = 0.06; // top of the scale (a loud-ish room)
  const W = 90;
  const H = 12;
  const fill = Math.min(1, props.level / METER_MAX);
  const mark = Math.min(1, props.threshold / METER_MAX);
  const over = props.level >= props.threshold;
  return (
    <div
      style={{
        position: "relative",
        width: W,
        height: H,
        borderRadius: 3,
        background: "#20202a",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          bottom: 0,
          width: fill * W,
          background: over ? "#1ed760" : "#5a5a66",
          transition: "width 60ms linear",
        }}
      />
      <div
        style={{ position: "absolute", left: mark * W, top: -2, bottom: -2, width: 2, background: "#ff5ea8" }}
      />
    </div>
  );
}

/**
 * Live pitch diagnostics. Watch the raw detector value flicker while "Off by"
 * (the smoothed, target-folded distance) stays steady — that's the smoothing
 * working. The Level meter shows your input against the sensitivity gate (pink):
 * frequent "no signal" means your level is dipping below the gate — raise
 * sensitivity or sing louder.
 */
function onOff(b: boolean | undefined): string {
  return b === undefined ? "?" : b ? "on" : "off";
}

function DebugPanel(props: {
  data: FrameDebug | null;
  micOn: boolean;
  level: number;
  threshold: number;
  applied: AppliedProcessing | null;
}) {
  const { data, micOn, level, threshold, applied } = props;
  const cell: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 2 };
  const label: React.CSSProperties = {
    fontSize: 10,
    letterSpacing: 1,
    color: "rgba(255,255,255,0.45)",
    textTransform: "uppercase",
  };
  const value: React.CSSProperties = { fontSize: 16, fontWeight: 700, fontVariantNumeric: "tabular-nums" };

  const raw = data?.rawMidi ?? null;
  const target = data?.targetPitch ?? null;
  const marker = data?.markerPitch ?? null;
  const hit = !!data?.markerHit;
  const off = marker != null && target != null ? marker - target : null;

  return (
    <div
      style={{
        position: "absolute",
        top: 10,
        left: 10,
        zIndex: 5,
        display: "flex",
        gap: 18,
        alignItems: "center",
        padding: "10px 14px",
        borderRadius: 10,
        background: "rgba(8,8,12,0.82)",
        border: "1px solid #2a2a33",
        color: "#fff",
        fontFamily: "ui-monospace, SFMono-Regular, monospace",
        pointerEvents: "none",
      }}
    >
      {!micOn ? (
        <span style={{ fontSize: 13, color: "rgba(255,255,255,0.6)" }}>
          🔬 enable 🎤 Mic to see live pitch
        </span>
      ) : (
        <>
          <div style={cell}>
            <span style={label}>Level</span>
            <LevelMeter level={level} threshold={threshold} />
          </div>
          <div style={cell}>
            <span style={label}>Detector</span>
            <span style={{ ...value, color: raw != null ? "#1ed760" : "#6d6d6d" }}>
              {raw != null ? `${noteName(raw)} ${raw.toFixed(1)}` : "— no signal"}
            </span>
          </div>
          <div style={cell}>
            <span style={label}>Target</span>
            <span style={value}>{pcLetter(target)}</span>
          </div>
          <div style={cell}>
            <span style={label}>Off by</span>
            <span style={value}>
              {off == null ? "—" : `${off > 0 ? "+" : ""}${off.toFixed(1)} st`}
            </span>
          </div>
          <div
            style={{
              ...value,
              padding: "4px 10px",
              borderRadius: 6,
              background: hit ? "rgba(30,215,96,0.2)" : "rgba(255,94,168,0.15)",
              color: hit ? "#1ed760" : "#ff5ea8",
            }}
          >
            {hit ? "HIT" : "miss"}
          </div>
          <div style={cell}>
            <span style={label}>Processing</span>
            <span style={{ fontSize: 12, fontVariantNumeric: "tabular-nums" }}>
              {/* AGC on is the prime suspect for a fading held note */}
              <span style={{ color: applied?.autoGainControl ? "#ff6b6b" : "rgba(255,255,255,0.7)" }}>
                AGC {onOff(applied?.autoGainControl)}
              </span>
              {" · "}
              <span style={{ color: applied?.noiseSuppression ? "#e6b422" : "rgba(255,255,255,0.7)" }}>
                NS {onOff(applied?.noiseSuppression)}
              </span>
              {" · "}
              <span style={{ color: "rgba(255,255,255,0.7)" }}>AEC {onOff(applied?.echoCancellation)}</span>
            </span>
          </div>
        </>
      )}
    </div>
  );
}

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

  // ?screen=session|picker opens straight to that surface (for dev + screenshots).
  const screenParam = params.get("screen");
  const initialMode =
    screenParam === "session" || screenParam === "nochart" || screenParam === "result"
      ? "session"
      : screenParam === "picker"
        ? "picker"
        : "karaoke";
  const [mode, setMode] = React.useState<"karaoke" | "picker" | "session">(initialMode);
  // Mock playlists + a load-state toggle to exercise the SessionSetup screen.
  const MOCK_PLAYLISTS: PlaylistRef[] = [
    { uri: "spotify:playlist:1", name: "Karaoke Bangers", count: 12 },
    { uri: "spotify:playlist:2", name: "90s Sing-alongs", count: 28 },
    { uri: "spotify:playlist:3", name: "Power Ballads (feat. way too many key changes)", count: 40 },
    { uri: "spotify:playlist:4", name: "Shower Setlist", count: null },
  ];
  const MOCK_DEVICES = [
    { deviceId: "default", label: "Built-in Microphone" },
    { deviceId: "usb", label: "USB Podcast Mic" },
    { deviceId: "headset", label: "Gaming Headset" },
  ];
  const [plLoading, setPlLoading] = React.useState(false);
  const [setupRounds, setSetupRounds] = React.useState(5);
  const [setupRoster, setSetupRoster] = React.useState<PlayerSlot[]>([
    { name: "P1", gain: 1, sensitivity: 70 },
  ]);
  // Fullscreen in-game overlay (SessionHud + KaraokeView) — the exact Spotify
  // stage, so its layout can be tuned in-browser. ?screen=ingame opens straight in.
  const [inGame, setInGame] = React.useState(params.get("screen") === "ingame");
  const [autoSkip, setAutoSkip] = React.useState(false);
  const [resetToken, setResetToken] = React.useState(0);
  const [sessionMsg, setSessionMsg] = React.useState<string | null>(null);
  // A mock 2-player hotseat result, built with the real session helpers.
  const demoSummary = React.useMemo(() => {
    const mk = (total: number): ScoreState =>
      ({ total, notesSung: 40, notesTotal: 44 }) as ScoreState;
    let s = createSession(4, ["Alex", "Sam"]);
    s = recordRound(s, roundFromScore("Bohemian Rhapsody", "Queen", mk(8200), "Alex"));
    s = recordRound(s, roundFromScore("Dancing Queen", "ABBA", mk(6400), "Sam"));
    s = recordRound(s, roundFromScore("Livin' on a Prayer", "Bon Jovi", mk(9100), "Alex"));
    s = recordRound(s, roundFromScore("Africa", "Toto", mk(7000), "Sam"));
    return summarize(s);
  }, []);
  // Toggle the session demo between setup, the no-chart card, and the result screen.
  const [sessionScreen, setSessionScreen] = React.useState<"setup" | "nochart" | "result">(
    params.get("screen") === "nochart"
      ? "nochart"
      : params.get("screen") === "result"
        ? "result"
        : "setup"
  );
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

  // Diagnostic overlay: KaraokeView reports raw/target/marker each frame into a
  // ref; the transport's per-frame repaint shows it live (no extra re-render).
  const [showDebug, setShowDebug] = React.useState(false);
  const debugRef = React.useRef<FrameDebug | null>(null);
  const onDebug = React.useCallback((d: FrameDebug) => {
    debugRef.current = d;
  }, []);

  // Mic sensitivity → the detector's RMS gate. Persisted; applied live.
  const [sensitivity, setSensitivity] = React.useState(loadSensitivity);
  const applySensitivity = (v: number) => {
    setSensitivity(v);
    localStorage.setItem(SENS_KEY, String(v));
    micRef.current?.setOptions({ rmsThreshold: sensitivityToThreshold(v) });
  };

  // Raw (no NS/AEC) is the default — it's what karaoke needs. Toggling this OFF
  // turns noise-suppression + echo-cancel back on, to A/B the held-note fade.
  const [rawMic, setRawMic] = React.useState(true);

  const beginMic = async (raw: boolean) => {
    setMicError(null);
    micRef.current = await startMicPitch({
      rmsThreshold: sensitivityToThreshold(sensitivity),
      noiseSuppression: !raw,
      echoCancellation: !raw,
      autoGainControl: false, // never — it smears pitch regardless
    });
    setMicOn(true);
  };

  const toggleMic = async () => {
    if (micRef.current) {
      micRef.current.stop();
      micRef.current = null;
      setMicOn(false);
      return;
    }
    try {
      await beginMic(rawMic);
    } catch (e) {
      setMicError(e instanceof Error ? e.message : "Mic access denied");
      setMicOn(false);
    }
  };

  const toggleRaw = async () => {
    const next = !rawMic;
    setRawMic(next);
    if (micRef.current) {
      micRef.current.stop();
      micRef.current = null;
      try {
        await beginMic(next); // restart with the new constraints
      } catch (e) {
        setMicError(e instanceof Error ? e.message : "Mic access denied");
        setMicOn(false);
      }
    }
  };

  // Stable getter (reads the ref) so KaraokeView's frame loop isn't rebuilt.
  const getLivePitchMidi = React.useCallback(
    () => micRef.current?.read()?.midi ?? null,
    []
  );

  // ── 2-player demo (no real mics) ──
  // Two synthetic singers track the chart at different accuracy, so the versus
  // rendering — two markers, two score HUDs — can be verified without hardware.
  const [twoPlayer, setTwoPlayer] = React.useState(params.get("versus") === "1");
  const songRef = React.useRef(song);
  songRef.current = song;
  // Two synthetic singers following the chart at different accuracy (stable
  // getters — getPositionMs + songRef are stable, so the frame loop isn't rebuilt).
  const singerA = React.useCallback((): number | null => {
    const t = targetPitchAt(songRef.current, getPositionMs());
    return t == null ? null : t + Math.sin(getPositionMs() / 140) * 0.35; // on-pitch
  }, []);
  const singerB = React.useCallback((): number | null => {
    const t = targetPitchAt(songRef.current, getPositionMs());
    return t == null ? null : t + 0.6 + Math.sin(getPositionMs() / 140) * 1.1; // sharp + wobbly
  }, []);

  // The players handed to KaraokeView: two synthetic in demo mode, else the
  // single real mic (when on). This is the harness's "mic port" adapter.
  const players: PlayerInput[] = twoPlayer
    ? [
        { id: "alex", name: "Alex", color: PLAYER_COLORS[0], getPitchMidi: singerA },
        { id: "sam", name: "Sam", color: PLAYER_COLORS[1], getPitchMidi: singerB },
      ]
    : micOn
      ? [{ id: "mic0", name: "P1", color: PLAYER_COLORS[0], getPitchMidi: getLivePitchMidi }]
      : [];

  // For the in-game overlay demo, always render at least one singer so the HUD +
  // score have something to show even with no mic and 2P off.
  const gamePlayers: PlayerInput[] =
    players.length > 0
      ? players
      : [{ id: "you", name: "P1", color: PLAYER_COLORS[0], getPitchMidi: singerA }];

  // Synthetic levels for the in-game meters — the harness has no live mic here,
  // so the banner still moves and can be eyeballed at its real size.
  const [hudSlots, setHudSlots] = React.useState<PlayerSlot[]>([]);
  React.useEffect(() => {
    setHudSlots((prev) =>
      gamePlayers.map(
        (p, i) => prev[i] ?? { name: p.name, gain: 1, sensitivity: sensitivity }
      )
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gamePlayers.length]);
  const hudMics = hudSlots.map((p) => ({
    ...p,
    getLevel: () => 0.02 + 0.025 * Math.abs(Math.sin(performance.now() / 300 + p.name.length)),
  }));
  const patchHud = (i: number, patch: Partial<PlayerSlot>) =>
    setHudSlots((r) => r.map((q, j) => (j === i ? { ...q, ...patch } : q)));

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
    <>
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
          singify ·{" "}
          {mode === "picker" ? "SongPicker" : mode === "session" ? "SessionSetup" : "KaraokeView"}{" "}
          harness
        </h2>
        <div style={{ display: "flex", gap: 8 }}>
          {mode === "karaoke" ? (
            <>
              <button style={stepBtn} onClick={openPicker}>
                Picker demo →
              </button>
              <button style={stepBtn} onClick={() => setMode("session")}>
                Session demo →
              </button>
            </>
          ) : (
            <button style={stepBtn} onClick={() => { onCancel(); setMode("karaoke"); }}>
              ← Back to karaoke
            </button>
          )}
        </div>
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
        <button
          onClick={() => setTwoPlayer((v) => !v)}
          title="Two synthetic singers — verify versus rendering without mics"
          style={{
            background: twoPlayer ? "#3a86ff" : "#2a2a33",
            color: "#fff",
            border: 0,
            borderRadius: 20,
            padding: "8px 14px",
            font: "700 13px system-ui",
            cursor: "pointer",
          }}
        >
          {twoPlayer ? "👥 2P demo ✓" : "👥 2P demo"}
        </button>
        <button
          onClick={() => { play(); setIsPlaying(true); setInGame(true); }}
          title="Open the fullscreen in-game stage (SessionHud + KaraokeView) — the exact Spotify layout"
          style={{
            background: "#8b5cf6",
            color: "#fff",
            border: 0,
            borderRadius: 20,
            padding: "8px 14px",
            font: "700 13px system-ui",
            cursor: "pointer",
          }}
        >
          🎮 In-game
        </button>
        <button
          onClick={() => setShowDebug((v) => !v)}
          style={{
            background: showDebug ? "#3a86ff" : "#2a2a33",
            color: "#fff",
            border: 0,
            borderRadius: 20,
            padding: "8px 14px",
            font: "700 13px system-ui",
            cursor: "pointer",
          }}
        >
          🔬 Debug
        </button>
        <button
          onClick={toggleRaw}
          title="Disable noise-suppression / echo-cancel / AGC to A/B held-note fade"
          style={{
            background: rawMic ? "#e6b422" : "#2a2a33",
            color: rawMic ? "#2a1e00" : "#fff",
            border: 0,
            borderRadius: 20,
            padding: "8px 14px",
            font: "700 13px system-ui",
            cursor: "pointer",
          }}
        >
          {rawMic ? "Raw mic ✓" : "Raw mic"}
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

      {/* Mic sensitivity — the detector's loudness gate. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginBottom: 14,
          color: "#c8c8c8",
          font: "500 13px system-ui",
        }}
      >
        <span style={{ opacity: 0.7 }}>Mic sensitivity</span>
        <input
          type="range"
          min={0}
          max={100}
          value={sensitivity}
          onChange={(e) => applySensitivity(Number(e.target.value))}
          style={{ width: 160 }}
        />
        <span style={{ minWidth: 38, textAlign: "center", fontVariantNumeric: "tabular-nums" }}>
          {sensitivity}%
        </span>
        <span style={{ opacity: 0.5, fontSize: 12 }}>
          higher = quiet singing detected (home) · lower = reject noise (party)
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
          position: "relative",
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
          players={players}
          onReplay={() => {
            seek(0);
            play();
            setIsPlaying(true);
          }}
          onDebug={showDebug ? onDebug : undefined}
        />
        {showDebug && (
          <DebugPanel
            data={debugRef.current}
            micOn={micOn}
            level={micOn ? micRef.current?.level() ?? 0 : 0}
            threshold={sensitivityToThreshold(sensitivity)}
            applied={micRef.current?.applied ?? null}
          />
        )}
      </div>
        </div>
      ) : mode === "picker" ? (
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
      ) : (
        <div>
          {sessionMsg && (
            <div style={{ color: "#1ed760", font: "600 13px system-ui", marginBottom: 10 }}>
              {sessionMsg}
            </div>
          )}
          <div style={{ marginBottom: 10, display: "flex", gap: 8 }}>
            {(["setup", "nochart", "result"] as const).map((sc) => (
              <button
                key={sc}
                style={{
                  ...stepBtn,
                  background: sessionScreen === sc ? "#1ed760" : "#2a2a33",
                  color: sessionScreen === sc ? "#08210f" : "#fff",
                }}
                onClick={() => setSessionScreen(sc)}
              >
                {sc === "setup" ? "Setup" : sc === "nochart" ? "No-chart" : "Result (2P)"}
              </button>
            ))}
            {sessionScreen === "setup" && (
              <button style={stepBtn} onClick={() => setPlLoading((v) => !v)}>
                {plLoading ? "Show playlists" : "Simulate loading…"}
              </button>
            )}
          </div>
          <div
            style={{
              minHeight: 640,
              borderRadius: 14,
              overflow: "auto",
              background: "linear-gradient(160deg, #14141c, #0c0c12)",
              border: "1px solid #23232c",
            }}
          >
            {sessionScreen === "nochart" ? (
              <NoChartInSession
                title="Some Deep Cut"
                artist="An Obscure Band"
                searched={true}
                onSkip={() => setSessionMsg("⏭ Would skip to the next playlist track")}
                onReChoose={() => setSessionMsg("🔎 Would re-search USDB for this track")}
              />
            ) : sessionScreen === "result" ? (
              <SessionResultScreen
                summary={demoSummary}
                onDone={() => setSessionMsg("✓ Done")}
                onSave={() => setSessionMsg("💾 Would save as a Spotify playlist")}
              />
            ) : (
              <SessionSetup
                playlists={MOCK_PLAYLISTS}
                loadingPlaylists={plLoading}
                current={{ uri: "spotify:playlist:now", name: "Road Trip 2026", count: null }}
                onStartPlaylist={(p) =>
                  setSessionMsg(`▶ Would start session from “${p.name}” (${p.count ?? "?"} songs)`)
                }
                rounds={setupRounds}
                onRounds={setSetupRounds}
                players={setupRoster}
                onName={(i, name) =>
                  setSetupRoster((r) => r.map((p, j) => (j === i ? { ...p, name } : p)))
                }
                onDevice={(i, deviceId) =>
                  setSetupRoster((r) => r.map((p, j) => (j === i ? { ...p, deviceId } : p)))
                }
                onGain={(i, gain) =>
                  setSetupRoster((r) => r.map((p, j) => (j === i ? { ...p, gain } : p)))
                }
                onAddPlayer={() =>
                  setSetupRoster((r) =>
                    r.length < 4
                      ? [...r, { name: `P${r.length + 1}`, gain: 1, sensitivity: 70 }]
                      : r
                  )
                }
                onRemovePlayer={(i) =>
                  setSetupRoster((r) => (r.length > 1 ? r.filter((_, j) => j !== i) : r))
                }
                devices={MOCK_DEVICES}
                levelFor={(i) => 0.015 + 0.02 * Math.abs(Math.sin(performance.now() / 300 + i))}
                onSensitivity={(i, n) =>
                  setSetupRoster((r) => r.map((q, j) => (j === i ? { ...q, sensitivity: n } : q)))
                }
                onStart={() => setSessionMsg(`▶ Would start free-play session: ${setupRounds} rounds`)}
                onCancel={() => { setSessionMsg(null); setMode("karaoke"); }}
                micOn={micOn}
              />
            )}
          </div>
        </div>
      )}
    </div>

    {inGame && (
      <div
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 100,
          background: "rgba(10,10,14,0.94)",
          backdropFilter: "blur(6px)",
        }}
      >
        <div
          style={{
            position: "relative",
            zoom: UI_SCALE,
            width: "100%",
            height: "100%",
          }}
        >
          {/* Same three-cell top row the Spotify adapter builds: HUD left,
              track centred, mic banner right. */}
          <div
            style={{
              position: "absolute",
              top: 24,
              left: 24,
              right: 24,
              zIndex: 6,
              display: "grid",
              gridTemplateColumns: "minmax(0, 1fr) auto minmax(0, 1fr)",
              alignItems: "start",
              gap: 24,
            }}
          >
            <div style={{ minWidth: 0 }}>
          <SessionHud
            round={1}
            target={5}
            totals={hudMics.map((m, i) => ({ name: m.name, total: 12800 - i * 3400 }))}
            micsOn={hudMics.length > 0}
            onSkip={() => seek(0)}
            onEnd={() => setInGame(false)}
            onResetScores={() => setResetToken((n) => n + 1)}
            onRestartSong={() => {
              seek(0);
              setResetToken((n) => n + 1);
            }}
            autoSkip={autoSkip}
            onAutoSkip={setAutoSkip}
            sourceName="Karaoke Bangers"
          />
            </div>
            <div style={{ minWidth: 0 }}>
              <NowPlaying
                title={song.headers.title ?? "Untitled"}
                artist={song.headers.artist ?? "Unknown"}
              />
            </div>
            <div style={{ minWidth: 0, display: "flex", justifyContent: "flex-end" }}>
          <MicOverlay
            mics={hudMics}
            devices={[
              { deviceId: "mic-a", label: "Logitech USB Mic" },
              { deviceId: "mic-b", label: "Built-in Microphone" },
            ]}
            outputs={[
              { deviceId: "out-a", label: "Headphones (USB)" },
              { deviceId: "out-b", label: "Built-in Speakers" },
              { deviceId: "out-c", label: "HDMI TV" },
            ]}
            routingSupported={true}
            onGain={(i, gain) => patchHud(i, { gain })}
            onSensitivity={(i, n) => patchHud(i, { sensitivity: n })}
            onDevice={(i, deviceId) => patchHud(i, { deviceId })}
            onMonitor={(i, on) => patchHud(i, { monitor: on })}
            onMonitorGain={(i, gain) => patchHud(i, { monitorGain: gain })}
            onOutput={(i, deviceId) => patchHud(i, { outputDeviceId: deviceId })}
          />
            </div>
          </div>
          <KaraokeView
            song={song}
            getPositionMs={getPositionMs}
            players={gamePlayers}
            resetToken={resetToken}
            fullscreen
          />
        </div>
        <button
          onClick={() => setInGame(false)}
          style={{ position: "fixed", top: 10, right: 12, zIndex: 110, ...stepBtn }}
        >
          ✕ exit in-game
        </button>
      </div>
    )}
    </>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
