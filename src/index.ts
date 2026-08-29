/**
 * index.ts — Spicetify extension entry point.
 *
 * Waits for Spicetify, tracks playback position (interpolated between
 * onprogress events), resolves an UltraStar chart for the current track, and
 * renders <KaraokeView> into a fullscreen overlay: `K` opens the menu, `Q`
 * sings the current track.
 *
 * NOTE (real-runtime, stage 2): the cache layer (src/cache.ts) uses node:fs to
 * persist songs under ~/spicetify-karaoke/. That requires a Node-capable
 * context; in a sandboxed renderer it must be reached via a preload bridge or
 * the Electron main process. For browser-harness development we exercise
 * <KaraokeView> directly with a fixture song and never touch the cache.
 */

import {
  KaraokeView,
  PLAYER_COLORS,
  type PlayerInput,
  type PlayerRoundScore,
} from "./karaoke-view";
import { SongPicker } from "./song-picker";
import { HomeMenu } from "./home-menu";
import {
  SessionSetup,
  SessionHud,
  MicOverlay,
  RoundEnd,
  SessionResultScreen,
  NoChartInSession,
  type PlayerSlot,
} from "./session-view";
import {
  createSession,
  createSessionFromPlaylist,
  recordRound,
  roundFromScores,
  isComplete,
  upNext,
  summarize,
  type Session,
  type RoundResult,
} from "./session";
import {
  fetchPlaylists,
  fetchPlaylistTracks,
  playPlaylist,
  currentContextPlaylist,
  type PlaylistRef,
} from "./playlist-source";
import { startMicPitch, enumerateInputs, type MicPitch, type AudioInput } from "./mic";
import { resolveForTrack, confirmPick } from "./resolver-client";
import { sensitivityToThreshold, thresholdToSensitivity } from "./pitch";
import { parse, type ParsedSong } from "./ultrastar-parser";
import type { USDBSong } from "./usdb";

// ── Playback clock (interpolated) ────────────────────────────────────────────
//
// getBaseMs() is Spotify's reported position, interpolated between onprogress
// events with performance.now(). getCurrentMs() adds the user's lyric offset on
// top — that's what <KaraokeView> reads. The offset is applied ONLY at this
// outer read, never folded back into the anchor (lastKnownMs), or every
// re-anchor on play/pause would compound it.

let lastKnownMs = 0;
let lastKnownAt = 0;
let paused = false;

function getBaseMs(): number {
  if (paused) return lastKnownMs;
  return lastKnownMs + (performance.now() - lastKnownAt);
}

function getCurrentMs(): number {
  return getBaseMs() + offsetMs;
}

function onProgress(e: SpicetifyPlayerEvent): void {
  lastKnownMs = Number(e.data) || 0;
  lastKnownAt = performance.now();
}

function onPlayPause(): void {
  // Re-anchor off the *base* clock (never the offset-adjusted one) so resume
  // doesn't jump.
  lastKnownMs = getBaseMs();
  lastKnownAt = performance.now();
  paused = !!Spicetify.Player.data?.isPaused;
}

// ── Lyric offset (audio-sync knob, per track) ────────────────────────────────
//
// Spotify's reported position and the real audio drift (output latency), and
// UltraStar GAP values are often off against Spotify's specific master — so the
// user nudges the whole karaoke timeline against what they hear. Positive =
// lyrics/notes fire earlier. Adjust live with [ and ] (±20 ms); \ resets.
//
// The offset is PER TRACK: each nudge is saved under the Spotify track's URI, so
// a song you've tuned once loads pre-aligned every time after. A track you've
// never tuned starts from `defaultOffset` (the legacy global value — a device
// latency baseline). This lives in the adapter, not <KaraokeView>: the offset is
// a property of the clock port, so the shared view never has to know about it.

const OFFSET_PREFIX = "singify:offset:"; // per track: singify:offset:<uri>
const DEFAULT_OFFSET_KEY = "singify:offsetMs"; // baseline for untuned tracks (+ legacy global)
const OFFSET_STEP = 20; // ms per nudge

function readNum(key: string): number | null {
  const raw = localStorage.getItem(key);
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

// Baseline for any track not yet individually tuned. Seeded from the legacy
// global key so existing setups keep their value.
let defaultOffset = readNum(DEFAULT_OFFSET_KEY) ?? 0;

function loadOffsetForTrack(trackId: string | null): number {
  if (!trackId) return defaultOffset;
  return readNum(OFFSET_PREFIX + trackId) ?? defaultOffset;
}

let offsetMs = defaultOffset; // updated per track on songchange

function setOffset(next: number): void {
  offsetMs = Math.round(next);
  // Persist against the current track so its tuning is remembered independently.
  // With no active track (e.g. a chart loaded via L before any songchange), fall
  // back to moving the global baseline instead.
  try {
    if (currentTrackId) {
      localStorage.setItem(OFFSET_PREFIX + currentTrackId, String(offsetMs));
    } else {
      defaultOffset = offsetMs;
      localStorage.setItem(DEFAULT_OFFSET_KEY, String(offsetMs));
    }
  } catch {
    /* storage blocked — keep the in-memory value */
  }
  showOffset();
}

// Transient on-screen readout — ONE reused DOM node (outside the React overlay,
// so <KaraokeView> stays untouched) shared by every live-adjust control. It just
// updates its text and resets a fade timer, so it stays instant no matter how
// fast you tap. Spicetify.showNotification queues a fresh toast per call and
// lags behind rapid presses — this doesn't, which is why the knobs use it.
let readoutEl: HTMLDivElement | null = null;
let readoutTimer = 0;

function showReadout(text: string): void {
  if (!readoutEl) {
    readoutEl = document.createElement("div");
    readoutEl.id = "singify-readout";
    Object.assign(readoutEl.style, {
      position: "fixed",
      bottom: "84px",
      left: "50%",
      transform: "translateX(-50%)",
      zIndex: "1000",
      padding: "32px 64px",
      borderRadius: "72px",
      background: "rgba(10, 10, 14, 0.92)",
      color: "#fff",
      font: "600 52px 'Spotify Circular', system-ui, sans-serif",
      pointerEvents: "none",
      opacity: "0",
      transition: "opacity 180ms ease",
    } as CSSStyleDeclaration);
    document.body.appendChild(readoutEl);
  }
  readoutEl.textContent = text;
  readoutEl.style.opacity = "1";
  clearTimeout(readoutTimer);
  readoutTimer = window.setTimeout(() => {
    if (readoutEl) readoutEl.style.opacity = "0";
  }, 1200);
}

function showOffset(): void {
  const sign = offsetMs > 0 ? "+" : "";
  // Signal the scope so the user knows the tuning sticks to this song.
  const scope = currentTrackId ? "this track" : "default";
  showReadout(`Lyric offset ${sign}${offsetMs} ms · ${scope}`);
}

// ── Punch-to-sync ────────────────────────────────────────────────────────────
//
// When a chart's #GAP is seconds off Spotify's master, nudging [ / ] 20 ms at a
// time is hopeless. Instead: press P the instant you hear the first sung word.
// We know the chart's first note time, so we snap it to "now" in one tap —
// offset = firstNoteMs − current position — then you fine-tune from there. Saved
// per track like any offset, so each song is punched once.
function firstNoteMs(song: ParsedSong): number | null {
  for (const line of song.lines) {
    const s = line.syllables[0];
    if (s) return s.startMs;
  }
  return null;
}

function punchSync(): void {
  if (!currentSong) {
    Spicetify.showNotification?.("Punch-sync: no chart loaded");
    return;
  }
  const firstMs = firstNoteMs(currentSong);
  if (firstMs == null) {
    Spicetify.showNotification?.("Punch-sync: chart has no notes");
    return;
  }
  setOffset(firstMs - getBaseMs()); // snap the first line to this moment
  const sign = offsetMs > 0 ? "+" : "";
  showReadout(`⏱ Punched — first line synced · offset ${sign}${offsetMs} ms`);
}

// ── Mic pitch ────────────────────────────────────────────────────────────────
//
// M toggles the mics. Each player's read() is polled by <KaraokeView> every
// frame via its own getPitchMidi; all the analysis is the pure detectPitch().

/** The roster whose mics we run: a versus session's players, or solo's "You". */
function activeRoster(): PlayerSlot[] {
  return session ? sessionRoster : soloRoster;
}

/** Write back to whichever roster is live — in-game edits must persist to it. */
function setActiveRoster(next: PlayerSlot[]): void {
  if (session) sessionRoster = next;
  else soloRoster = next;
}

/** Open one mic for roster slot i, or null if its device won't open. */
async function openMic(p: PlayerSlot): Promise<MicPitch | null> {
  try {
    return await startMicPitch({
      deviceId: p.deviceId,
      gain: p.gain,
      rmsThreshold: sensitivityToThreshold(p.sensitivity),
    });
  } catch (err) {
    // One player's device failing shouldn't sink the others.
    console.error(`[singify] mic for ${p.name} failed:`, err);
    Spicetify.showNotification?.(`Mic unavailable for ${p.name}`, true);
    return null;
  }
}

/** Start one mic per player in the active roster — each on its own device. */
async function startMics(): Promise<void> {
  const roster = activeRoster();
  mics = await Promise.all(roster.map(openMic));
  const live = micCount();
  if (live === 0) Spicetify.showNotification?.("Mic access denied", true);
  else Spicetify.showNotification?.(live > 1 ? `🎤 ${live} mics on` : "🎤 Mic on");
  void loadDevices(); // the in-game device picker needs labels
  if (visible) renderOverlay(); // start a fresh scored attempt
}

/** Stop every mic and drop scoring/HUD. `quiet` suppresses the toast (restart). */
function stopMics(quiet = false): void {
  for (const m of mics) m?.stop();
  mics = [];
  if (!quiet) Spicetify.showNotification?.("Mic off");
  if (visible) renderOverlay();
}

/** M hotkey: toggle all mics for the active roster. */
async function toggleMics(): Promise<void> {
  if (mics.length) stopMics();
  else await startMics();
}

function micCount(): number {
  return mics.filter(Boolean).length;
}

function micsActive(): boolean {
  return micCount() > 0;
}

// ── Per-player mic controls (live, in-game) ─────────────────────────────────
//
// The banner edits the ACTIVE roster, and each change is pushed at the one
// running mic that owns it. Gain and gate apply without a restart; only a
// device swap has to tear its mic down and open a new one.

/** Apply a patch to active-roster slot i and re-render. */
function patchSlot(i: number, patch: Partial<PlayerSlot>): PlayerSlot | null {
  const roster = activeRoster();
  const slot = roster[i];
  if (!slot) return null;
  const next = { ...slot, ...patch };
  setActiveRoster(roster.map((p, j) => (j === i ? next : p)));
  return next;
}

function setPlayerGain(i: number, gain: number): void {
  if (!patchSlot(i, { gain })) return;
  mics[i]?.setGain(gain); // live — no restart
  if (visible) renderOverlay();
}

function setPlayerSensitivity(i: number, value: number): void {
  const n = Math.min(100, Math.max(0, Math.round(value)));
  if (!patchSlot(i, { sensitivity: n })) return;
  mics[i]?.setOptions({ rmsThreshold: sensitivityToThreshold(n) });
  savePlayerSensitivities(activeRoster());
  if (visible) renderOverlay();
}

async function setPlayerDevice(i: number, deviceId: string | undefined): Promise<void> {
  const next = patchSlot(i, { deviceId });
  if (!next) return;
  if (mics.length) {
    mics[i]?.stop();
    mics[i] = await openMic(next); // a device swap is the one thing that restarts
  }
  if (visible) renderOverlay();
}

/**
 * The active singers handed to KaraokeView — one entry per LIVE mic. Solo has
 * one; a versus session has one per player, each reading its own device. The
 * marker/HUD colour is by slot index, matching the setup-screen dots.
 */
function activePlayers(): PlayerInput[] {
  const roster = activeRoster();
  const out: PlayerInput[] = [];
  mics.forEach((m, i) => {
    const p = roster[i];
    if (!m || !p) return;
    out.push({
      id: `mic${i}`,
      name: p.name,
      color: PLAYER_COLORS[i % PLAYER_COLORS.length],
      getPitchMidi: () => m.read()?.midi ?? null,
    });
  });
  return out;
}

/** "Sing again" from the result screen — restart the track from the top. */
function onReplay(): void {
  try {
    (Spicetify.Player as { seek?: (ms: number) => void }).seek?.(0);
  } catch (err) {
    console.error("[singify] replay seek failed:", err);
  }
}

// ── Mic sensitivity ──────────────────────────────────────────────────────────
//
// The detector's RMS gate, as a 0..100 "sensitivity" (higher = quieter input
// passes). Adjust live with - and = ; persisted like the lyric offset. Applies
// immediately to a running mic. A property of the mic port — the view is untouched.

const SENS_KEY = "singify:sensitivity";
// Bumped whenever the sensitivity→RMS curve changes: the stored 0..100 number is
// meaningless without the curve it was written against. v2 widened the gate's
// quiet-end limit (0.05 → 0.12 RMS) so a genuinely loud room can be gated out.
const SENS_SCALE_KEY = "singify:sensitivityScale";
const SENS_SCALE = "v2";

/** The v1 curve — kept ONLY to re-express an old stored value on the v2 one. */
function v1Threshold(sensitivity: number): number {
  const s = Math.min(100, Math.max(0, sensitivity));
  return 0.05 * (0.003 / 0.05) ** (s / 100);
}

function loadSensitivity(): number {
  const v = Number(localStorage.getItem(SENS_KEY));
  if (!Number.isFinite(v) || v < 0 || v > 100) return 70;
  if (localStorage.getItem(SENS_SCALE_KEY) === SENS_SCALE) return v;
  // Migrate by GATE, not by number: convert the old slider value to the RMS it
  // used to mean, then ask the new curve for the slider value that means it.
  const migrated = Math.round(thresholdToSensitivity(v1Threshold(v)));
  try {
    localStorage.setItem(SENS_KEY, String(migrated));
    localStorage.setItem(SENS_SCALE_KEY, SENS_SCALE);
  } catch {
    /* storage blocked — the in-memory value is migrated either way */
  }
  return migrated;
}

// The gate is PER PLAYER (each meter drags its own). This global is two things:
// the default handed to a freshly added slot, and what the -/= hotkeys set —
// they move everybody at once, which is the "the room got loud" case.
let sensitivity = loadSensitivity();

/** Per-slot gates, by roster index; a slot with no stored value takes the default. */
const PLAYER_SENS_KEY = "singify:playerSens";

function loadPlayerSensitivities(): number[] {
  try {
    const raw = JSON.parse(localStorage.getItem(PLAYER_SENS_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((n) => typeof n === "number") : [];
  } catch {
    return [];
  }
}

function savePlayerSensitivities(roster: PlayerSlot[]): void {
  try {
    localStorage.setItem(PLAYER_SENS_KEY, JSON.stringify(roster.map((p) => p.sensitivity)));
  } catch {
    /* storage blocked — the in-memory roster still holds the values */
  }
}

/** The gate a newly created slot at index i starts from. */
function defaultSensitivityFor(i: number): number {
  return loadPlayerSensitivities()[i] ?? sensitivity;
}

function setSensitivity(next: number): void {
  sensitivity = Math.min(100, Math.max(0, Math.round(next)));
  try {
    localStorage.setItem(SENS_KEY, String(sensitivity));
    localStorage.setItem(SENS_SCALE_KEY, SENS_SCALE);
  } catch {
    /* storage blocked — keep the in-memory value */
  }
  const t = sensitivityToThreshold(sensitivity);
  // -/= is the blunt instrument: every singer's gate moves together.
  setActiveRoster(activeRoster().map((p) => ({ ...p, sensitivity })));
  setupRoster = setupRoster.map((p) => ({ ...p, sensitivity }));
  for (const m of mics) m?.setOptions({ rmsThreshold: t });
  for (const m of previewMics) m?.setOptions({ rmsThreshold: t });
  savePlayerSensitivities(activeRoster());
  showReadout(`🎤 Sensitivity ${sensitivity}%`);
  if (visible) renderOverlay(); // move the gate marker on every live meter
}

// ── Load a local chart (no USDB) ─────────────────────────────────────────────
//
// Opens a file picker for an UltraStar .txt so you can sing along in Spotify
// without a USDB account: play the matching track, press L, pick the file.
function loadLocalChart(): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".txt,text/plain";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const song = parse(await file.text());
      if (song.lines.length === 0) throw new Error("no singable notes found");
      currentSong = song;
      manualChart = true;
      pickerCandidates = null;
      pickError = null;
      if (!visible) setVisible(true);
      else renderOverlay();
      Spicetify.showNotification?.(
        `🎤 ${song.headers.artist} – ${song.headers.title} loaded`
      );
    } catch (err) {
      Spicetify.showNotification?.(
        `Chart parse failed: ${err instanceof Error ? err.message : String(err)}`,
        true
      );
    }
  };
  input.click();
}

// ── Overlay + render ─────────────────────────────────────────────────────────

let overlay: HTMLDivElement | null = null;
let root: { render(el: unknown): void; unmount(): void } | null = null;
let currentSong: ParsedSong | null = null;
let visible = false;
// Which screen the overlay shows. "sing" is the karaoke surface (Q / Quick Sing,
// today's behaviour); the rest are the session flow.
type Screen = "home" | "sing" | "session-setup" | "round-end" | "session-result";
// NB: named `activeScreen`, NOT `screen`. Spicetify loads this bundle as a classic
// <script>, so a top-level `let screen` binds in the GLOBAL lexical scope and shadows
// window.screen for the entire page. Spotify's own hooks then run
// `"addEventListener" in screen`, hit our string instead of the Screen object, throw a
// TypeError mid-render, and blank the whole client. Keep UI state namespaced.
let activeScreen: Screen = "sing";

// Active multi-round session (null = just Quick Sing). setupRounds is the pending
// choice on the setup screen; lastRound + scoredTrackIds track round bookkeeping.
let session: Session | null = null;
let setupRounds = 5;
/** A fresh roster slot: unity gain on the default mic, with slot i's saved gate. */
function newSlot(i: number, name: string): PlayerSlot {
  return { name, gain: 1, sensitivity: defaultSensitivityFor(i) };
}

// Versus roster chosen on the setup screen: each player + their mic device + gain.
let setupRoster: PlayerSlot[] = [newSlot(0, "You")];
// Snapshot of the roster taken when a session starts (the setup screen can keep
// changing after). Solo/Quick-Sing uses a lone default-device "You".
let sessionRoster: PlayerSlot[] = [newSlot(0, "You")];
// Solo / Quick-Sing has a roster too, so its single mic gets the same live
// controls (gate, gain, device) the versus banner gives every player.
let soloRoster: PlayerSlot[] = [newSlot(0, "You")];
// Audio input devices for the setup mic picker (populated when it opens).
let audioInputs: AudioInput[] = [];
let lastRound: RoundResult | null = null;
let scoredTrackIds = new Set<string>(); // one round per distinct track per session
// Playlist picker on the setup screen: the user's playlists + load state.
let playlists: PlaylistRef[] = [];
let playlistsLoading = false;
// Set when a chart is loaded manually (L hotkey) instead of resolved from USDB —
// lets you sing along in Spotify without a USDB account. While set, songchange
// won't overwrite the chart (reload the client to go back to auto-resolve).
let manualChart = false;

// Picker state — set when resolveForTrack returns candidates to choose from.
let currentTrackId: string | null = null;
// True while a chart lookup for the current track is in flight — lets the
// session no-chart card distinguish "still looking" from "searched, none found".
let resolving = false;
let pickerQuery: { artist?: string; title?: string } | null = null;
let pickerCandidates: USDBSong[] | null = null;
let pickPending: number | null = null;
let pickError: string | null = null;

// One entry per slot of the ACTIVE ROSTER, index-aligned to it; null means that
// player's device failed to open while the others carried on. Empty = mic off.
// Keeping the indices aligned is what lets a per-player control (gain, gate,
// device) address one singer, and keeps colours pinned to roster position even
// when a mic in the middle fails. `mics` is not a Window global (unlike
// `screen`), so it's safe at module scope; see the activeScreen note above.
let mics: (MicPitch | null)[] = [];
// Live preview mics on the setup screen — one per roster slot — so you can tune
// gain + gate against a moving meter BEFORE the session starts. Parallel to
// setupRoster; stopped when the session begins or the setup screen is left.
let previewMics: (MicPitch | null)[] = [];

function ensureOverlay(): HTMLDivElement {
  if (overlay) return overlay;
  overlay = document.createElement("div");
  overlay.id = "singify-overlay";
  Object.assign(overlay.style, {
    position: "fixed",
    inset: "0",
    zIndex: "999",
    background: "rgba(10, 10, 14, 0.94)",
    backdropFilter: "blur(6px)",
    display: "none",
  } as CSSStyleDeclaration);
  document.body.appendChild(overlay);

  const rd = Spicetify.ReactDOM;
  if (rd.createRoot) {
    root = rd.createRoot(overlay);
  } else if (rd.render) {
    // Legacy ReactDOM.render shim.
    root = {
      render: (el: unknown) => rd.render!(el, overlay!),
      unmount: () => {},
    };
  }
  return overlay;
}

function renderOverlay(): void {
  if (!root) return;
  const React = Spicetify.React;

  if (activeScreen === "home") {
    const item = Spicetify.Player.data?.item ?? Spicetify.Player.data?.track;
    const track = item
      ? { artist: item.artists?.[0]?.name ?? "", title: item.name ?? "" }
      : null;
    root.render(
      React.createElement(HomeMenu, {
        track,
        onQuickSing: () => {
          activeScreen = "sing";
          renderOverlay();
        },
        onStartSession: openSessionSetup,
      })
    );
    return;
  }

  if (activeScreen === "session-setup") {
    root.render(
      React.createElement(SessionSetup, {
        playlists,
        loadingPlaylists: playlistsLoading,
        current: currentContextPlaylist(),
        onStartPlaylist: (ref: PlaylistRef) => void startPlaylistSession(ref),
        rounds: setupRounds,
        onRounds: (n: number) => {
          setupRounds = n;
          renderOverlay();
        },
        players: setupRoster,
        onName: (i: number, name: string) => {
          setupRoster = setupRoster.map((p, j) => (j === i ? { ...p, name } : p));
          renderOverlay();
        },
        onDevice: (i: number, deviceId: string | undefined) => {
          setupRoster = setupRoster.map((p, j) => (j === i ? { ...p, deviceId } : p));
          void startPreviewMic(i); // rebind this slot's preview to the new device
          renderOverlay();
        },
        onGain: (i: number, gain: number) => {
          setupRoster = setupRoster.map((p, j) => (j === i ? { ...p, gain } : p));
          previewMics[i]?.setGain(gain); // live — no restart
          renderOverlay();
        },
        onAddPlayer: () => {
          if (setupRoster.length >= 4) return;
          setupRoster = [
            ...setupRoster,
            newSlot(setupRoster.length, `P${setupRoster.length + 1}`),
          ];
          void startPreviewMic(setupRoster.length - 1);
          renderOverlay();
        },
        onRemovePlayer: (i: number) => {
          if (setupRoster.length <= 1) return;
          previewMics[i]?.stop();
          previewMics = previewMics.filter((_, j) => j !== i);
          setupRoster = setupRoster.filter((_, j) => j !== i);
          renderOverlay();
        },
        devices: audioInputs,
        levelFor: previewLevel,
        onSensitivity: (i: number, n: number) => {
          setupRoster = setupRoster.map((q, j) => (j === i ? { ...q, sensitivity: n } : q));
          previewMics[i]?.setOptions({ rmsThreshold: sensitivityToThreshold(n) });
          savePlayerSensitivities(setupRoster);
          renderOverlay();
        },
        onStart: startSession,
        onCancel: () => {
          stopPreviews();
          activeScreen = "home";
          renderOverlay();
        },
        micOn: micsActive(),
      })
    );
    return;
  }

  if (activeScreen === "round-end" && session && lastRound) {
    root.render(
      React.createElement(RoundEnd, {
        justFinished: lastRound,
        roundNumber: session.rounds.length,
        target: session.targetRounds,
        sessionTotal: sessionTotal(),
        onContinue: continueSession,
        upNext: upNext(session),
      })
    );
    return;
  }

  if (activeScreen === "session-result" && session) {
    root.render(
      React.createElement(SessionResultScreen, {
        summary: summarize(session),
        onDone: finishSession,
        onSave: () =>
          Spicetify.showNotification?.("Saving sessions as playlists is coming next 💾"),
      })
    );
    return;
  }

  // activeScreen === "sing": the karaoke surface (chart / picker / no-chart), wrapped
  // in the session HUD when a session is running.
  const singContent = currentSong
    ? React.createElement(KaraokeView, {
        song: currentSong,
        getPositionMs: getCurrentMs,
        players: activePlayers(), // one entry per live mic — N in a versus session
        onReplay,
        onComplete: session ? onRoundComplete : undefined, // sessions record + advance
        fullscreen: true,
      })
    : pickerCandidates
      ? React.createElement(SongPicker, {
          candidates: pickerCandidates,
          query: pickerQuery ?? undefined,
          pendingId: pickPending,
          error: pickError,
          onPick,
          onCancel,
        })
      : session
        ? React.createElement(NoChartInSession, {
            title: currentTitle(),
            artist: currentArtist(),
            onSkip: skipRound,
            onReChoose: () => void reSearch(),
            searched: !resolving,
          })
        : React.createElement(
            "div",
            {
              style: {
                display: "flex",
                height: "100vh",
                alignItems: "center",
                justifyContent: "center",
                color: "#c8c8c8",
                fontSize: 20,
              },
            },
            "No karaoke chart for this track."
          );

  // Live level meters ride over the karaoke surface in BOTH modes as one centred
  // banner, so a singer can watch their level against the gate mid-song. A
  // session adds its own HUD (round/total/buttons) beside it, top-left.
  // Index-aligned to the active roster; a slot whose device failed is dropped so
  // the banner only shows strips you can actually watch move.
  const hudMics = activeRoster()
    .map((p, i) => ({ ...p, index: i, pitch: mics[i] }))
    .filter((e) => e.pitch)
    .map((e) => ({ ...e, getLevel: () => e.pitch?.level() ?? 0 }));
  const micBanner = hudMics.length
    ? React.createElement(MicOverlay, {
        mics: hudMics,
        devices: audioInputs,
        onGain: (i: number, gain: number) => setPlayerGain(hudMics[i]?.index ?? i, gain),
        onSensitivity: (i: number, n: number) =>
          setPlayerSensitivity(hudMics[i]?.index ?? i, n),
        onDevice: (i: number, deviceId: string | undefined) =>
          void setPlayerDevice(hudMics[i]?.index ?? i, deviceId),
      })
    : null;

  if (session) {
    root.render(
      React.createElement(
        "div",
        { style: { position: "relative", height: "100vh" } },
        React.createElement(SessionHud, {
          round: Math.min(session.rounds.length + 1, session.targetRounds),
          target: session.targetRounds,
          totals: sessionTotals(),
          micsOn: micsActive(),
          onSkip: skipRound,
          onEnd: endSession,
          autoSkip: autoSkipNoChart,
          onAutoSkip: setAutoSkip,
          sourceName: session.playlistName,
        }),
        micBanner,
        singContent
      )
    );
    return;
  }

  if (micBanner) {
    root.render(
      React.createElement(
        "div",
        { style: { position: "relative", height: "100vh" } },
        micBanner,
        singContent
      )
    );
    return;
  }

  root.render(singContent);
}

function setVisible(next: boolean): void {
  visible = next;
  const el = ensureOverlay();
  el.style.display = visible ? "block" : "none";
  if (visible) renderOverlay();
  else stopPreviews(); // closing the overlay releases any setup preview mics
}

// Q → the karaoke surface (Quick Sing); toggles closed if already there.
function openSing(): void {
  if (visible && activeScreen === "sing") {
    setVisible(false);
    return;
  }
  activeScreen = "sing";
  setVisible(true);
}

// K / Topbar button → the session menu; toggles closed if already there.
function openHome(): void {
  if (visible && activeScreen === "home") {
    setVisible(false);
    return;
  }
  activeScreen = "home";
  setVisible(true);
}

// ── Sessions (multi-round) ───────────────────────────────────────────────────

/** Per-player running totals across completed rounds, in roster order. */
function sessionTotals(): { name: string; total: number }[] {
  return session
    ? summarize(session).players.map((p) => ({ name: p.player, total: p.total }))
    : [];
}

/** Running score across the rounds completed so far (headline player). */
function sessionTotal(): number {
  return session
    ? session.rounds.reduce((sum, r) => sum + (r.scores[0]?.total ?? 0), 0)
    : 0;
}

/** Open the setup screen and (re)load playlists + input devices in the background. */
function openSessionSetup(): void {
  activeScreen = "session-setup";
  renderOverlay();
  void loadPlaylists();
  void loadDevices();
}

/**
 * Populate the input-device list for the setup mic picker. Browsers withhold
 * device labels until one mic grant, so prime a throwaway getUserMedia first —
 * this also pre-authorises, so starting the session won't re-prompt.
 */
async function loadDevices(): Promise<void> {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const t of s.getTracks()) t.stop();
  } catch (err) {
    console.error("[singify] mic permission for device list denied:", err);
  }
  audioInputs = await enumerateInputs();
  if (activeScreen === "session-setup") {
    renderOverlay();
    void startPreviews(); // live meters need a running mic per slot
  }
}

// ── Setup-screen mic previews ────────────────────────────────────────────────
// One live mic per roster slot while the setup screen is open, so the meters
// move and gain/gate can be tuned before the session. Stopped on Start/Cancel.

/** (Re)start the preview mic for roster slot i on its current device + gain. */
async function startPreviewMic(i: number): Promise<void> {
  const p = setupRoster[i];
  if (!p) return;
  previewMics[i]?.stop();
  try {
    previewMics[i] = await startMicPitch({
      deviceId: p.deviceId,
      gain: p.gain,
      rmsThreshold: sensitivityToThreshold(p.sensitivity),
    });
  } catch (err) {
    console.error(`[singify] preview mic for ${p.name} failed:`, err);
    previewMics[i] = null;
  }
  if (activeScreen === "session-setup") renderOverlay();
}

/** Start a preview mic for every roster slot. */
async function startPreviews(): Promise<void> {
  stopPreviews();
  previewMics = new Array(setupRoster.length).fill(null);
  await Promise.all(setupRoster.map((_, i) => startPreviewMic(i)));
}

/** Stop and drop all preview mics. */
function stopPreviews(): void {
  for (const m of previewMics) m?.stop();
  previewMics = [];
}

/** Live level (0..~0.4) for slot i's preview mic — feeds the setup meter. */
function previewLevel(i: number): number {
  return previewMics[i]?.level() ?? 0;
}

async function loadPlaylists(): Promise<void> {
  playlistsLoading = true;
  if (activeScreen === "session-setup") renderOverlay();
  try {
    playlists = await fetchPlaylists();
  } finally {
    playlistsLoading = false;
    if (activeScreen === "session-setup") renderOverlay();
  }
}

/** Start a fresh FREE-PLAY session: N rounds off whatever's queued. */
function startSession(): void {
  session = createSession(setupRounds, setupRoster.map((p) => p.name));
  sessionRoster = setupRoster.map((p) => ({ ...p }));
  scoredTrackIds = new Set();
  lastRound = null;
  // A scored session needs a mic per player; (re)bind to the roster's devices.
  stopPreviews(); // leaving setup — drop preview mics before the real ones
  if (micsActive()) stopMics(true);
  void startMics();
  activeScreen = "sing";
  renderOverlay();
}

/**
 * Start a session sourced from a playlist: fetch its tracks, bind the round
 * count to them, start playback from the top, and sing. Advancing rounds
 * (continue/skip) rides Spotify's own playlist ordering via Player.next().
 */
async function startPlaylistSession(ref: PlaylistRef): Promise<void> {
  Spicetify.showNotification?.(`Loading “${ref.name}”…`);
  const tracks = await fetchPlaylistTracks(ref.uri);
  if (tracks.length === 0) {
    Spicetify.showNotification?.(`“${ref.name}” has no playable tracks`, true);
    return;
  }
  session = createSessionFromPlaylist(ref.name, tracks, setupRoster.map((p) => p.name));
  sessionRoster = setupRoster.map((p) => ({ ...p }));
  scoredTrackIds = new Set();
  lastRound = null;
  stopPreviews(); // leaving setup — drop preview mics before the real ones
  if (micsActive()) stopMics(true);
  void startMics();
  activeScreen = "sing";
  renderOverlay();
  // Kick Spotify into the playlist from track 1; songchange re-renders with the
  // resolved chart. If playback couldn't start, we still show the sing screen —
  // the user can hit play themselves.
  const ok = await playPlaylist(ref.uri);
  if (!ok) {
    Spicetify.showNotification?.(
      "Couldn't auto-start the playlist — press play to begin",
      true
    );
  }
}

/** Fired by KaraokeView when a song finishes while scoring — records the round.
 *  scores has one entry (hotseat, this round's singer) or N (versus). */
function onRoundComplete(scores: PlayerRoundScore[]): void {
  if (!session || !currentSong || !currentTrackId) return;
  if (scoredTrackIds.has(currentTrackId)) return; // one round per song
  if (scores.length === 0) return;
  scoredTrackIds.add(currentTrackId);
  const r = roundFromScores(
    currentSong.headers.title,
    currentSong.headers.artist,
    scores.map((s) => ({ player: s.name, score: s.score }))
  );
  session = recordRound(session, r);
  lastRound = r;
  activeScreen = isComplete(session) ? "session-result" : "round-end";
  renderOverlay();
}

/** From RoundEnd — nudge Spotify to the next track; songchange returns to sing. */
function continueSession(): void {
  try {
    (Spicetify.Player as { next?: () => void }).next?.();
  } catch (err) {
    console.error("[singify] session next failed:", err);
  }
}

// ── Auto-skip chartless tracks (sessions) ───────────────────────────────────
//
// A 79-track playlist is full of songs USDB has never seen. With this on a
// session hops straight past them instead of parking on the no-chart card. Only
// a genuine "nothing found" triggers it — a picker means we DID find candidates,
// which is a choice worth stopping for.
const AUTOSKIP_KEY = "singify:autoSkipNoChart";
let autoSkipNoChart = localStorage.getItem(AUTOSKIP_KEY) === "1";
// Without a cap, a long chartless stretch would race through the whole playlist
// in seconds. After this many misses in a row, switch the toggle back off so the
// stop is VISIBLE in the HUD rather than being invisible internal state.
const AUTOSKIP_LIMIT = 8;
let autoSkipStreak = 0;

function setAutoSkip(on: boolean): void {
  autoSkipNoChart = on;
  autoSkipStreak = 0;
  try {
    localStorage.setItem(AUTOSKIP_KEY, on ? "1" : "0");
  } catch {
    /* storage blocked — keep the in-memory value */
  }
  if (visible) renderOverlay();
}

/** From the HUD "Skip" — don't count this song; play another. Slot stays open. */
function skipRound(): void {
  try {
    (Spicetify.Player as { next?: () => void }).next?.();
  } catch (err) {
    console.error("[singify] skip failed:", err);
  }
}

/** From the HUD "End" — finish early: show results if any rounds ran, else bail. */
function endSession(): void {
  if (session && session.rounds.length > 0) {
    activeScreen = "session-result";
  } else {
    session = null;
    activeScreen = "home";
  }
  renderOverlay();
}

/** Close out a finished session and return to the menu. */
function finishSession(): void {
  session = null;
  lastRound = null;
  scoredTrackIds = new Set();
  activeScreen = "home";
  renderOverlay();
}

// ── Song resolution ──────────────────────────────────────────────────────────

/** The track Spotify is currently on (item / track alias), or null. */
function currentItem(): SpicetifyTrackItem | null {
  return Spicetify.Player.data?.item ?? Spicetify.Player.data?.track ?? null;
}
function currentTitle(): string {
  return currentItem()?.name ?? "";
}
function currentArtist(): string {
  return currentItem()?.artists?.[0]?.name ?? "";
}

/** User chose a candidate from the picker — download, cache, and show it. */
async function onPick(candidate: USDBSong): Promise<void> {
  if (!currentTrackId) return;
  pickPending = candidate.id;
  pickError = null;
  if (visible) renderOverlay();

  try {
    const song = await confirmPick(currentTrackId, candidate);
    pickerCandidates = null; // success — drop the picker, show the chart
    pickPending = null;
    currentSong = song;
  } catch (err) {
    // TODO(stage 2): on SessionExpiredError, re-login with stored credentials
    // and retry once before surfacing this.
    pickPending = null;
    pickError =
      err instanceof Error ? err.message : "Download failed — try another match.";
    console.error("[singify] pick failed:", err);
  }

  if (visible) renderOverlay();
}

function onCancel(): void {
  pickerCandidates = null;
  pickPending = null;
  pickError = null;
  if (visible) renderOverlay();
}

async function onSongChange(): Promise<void> {
  // A manually-loaded chart (L) wins — don't let a songchange event wipe it.
  if (manualChart) return;

  const item = Spicetify.Player.data?.item ?? Spicetify.Player.data?.track;
  if (!item?.uri) return;
  const title = item.name ?? "";
  const artist = item.artists?.[0]?.name ?? "";

  // Reset per-track state.
  currentSong = null;
  currentTrackId = item.uri;
  offsetMs = loadOffsetForTrack(currentTrackId); // this song's remembered tuning
  pickerCandidates = null;
  pickPending = null;
  pickError = null;
  resolving = true; // chart lookup in flight
  let noChart = false; // set when the lookup finds nothing at all (not a picker)
  if (visible) renderOverlay();

  try {
    const res = await resolveForTrack(item.uri, artist, title);
    if (
      res.status === "cached" ||
      res.status === "downloaded" ||
      res.status === "local"
    ) {
      currentSong = res.song;
      autoSkipStreak = 0; // a hit ends the chartless run
    } else if (res.status === "needsPicker") {
      pickerQuery = { artist, title };
      pickerCandidates = res.candidates;
      if (!visible) {
        Spicetify.showNotification?.(
          `Karaoke: ${res.candidates.length} matches for “${title}” — press Q to choose`
        );
      }
    } else {
      noChart = true;
      if (!(session && autoSkipNoChart)) {
        Spicetify.showNotification?.(`No karaoke chart for “${title}”`);
      }
    }
  } catch (err) {
    console.error("[singify] resolve failed:", err);
    // A TypeError from fetch means the helper isn't reachable (connection
    // refused) — the most likely first-run cause. Anything else is a real
    // lookup error from the helper, so show its message.
    const msg =
      err instanceof TypeError
        ? "Karaoke helper not running — start it with `bun run helper`"
        : `Karaoke lookup failed: ${err instanceof Error ? err.message : String(err)}`;
    Spicetify.showNotification?.(msg, true);
  } finally {
    resolving = false; // lookup settled (found, picker, or nothing)
  }

  // In a session, playing a new song advances from the between-rounds screen
  // back to singing (the follow model — you queued up the next song).
  if (session && activeScreen === "round-end") activeScreen = "sing";

  if (noChart && session && autoSkipNoChart) {
    if (autoSkipStreak >= AUTOSKIP_LIMIT) {
      Spicetify.showNotification?.(
        `Auto-skip off — ${AUTOSKIP_LIMIT} tracks in a row had no chart`,
        true
      );
      setAutoSkip(false);
    } else {
      autoSkipStreak++;
      skipRound(); // the next songchange renders; nothing is recorded
      return;
    }
  }

  if (visible) renderOverlay();
}

// ── Re-choose (force a fresh USDB search) ────────────────────────────────────
//
// "L, but remote": ignore the local chart AND the cache, search USDB fresh, and
// reopen the picker with every match — to pick a different chart, retry a song
// USDB has now (but didn't before), or recover a picker you dismissed.
async function reSearch(): Promise<void> {
  const item = Spicetify.Player.data?.item ?? Spicetify.Player.data?.track;
  if (!item?.uri) return;
  const title = item.name ?? "";
  const artist = item.artists?.[0]?.name ?? "";

  manualChart = false; // re-enable auto-resolve on later songchanges too
  currentSong = null;
  currentTrackId = item.uri;
  pickerCandidates = null;
  pickPending = null;
  pickError = null;
  resolving = true;
  Spicetify.showNotification?.(`🔎 Searching USDB for “${title}”…`);
  if (!visible) setVisible(true);
  else renderOverlay();

  try {
    const res = await resolveForTrack(item.uri, artist, title, true);
    if (res.status === "needsPicker") {
      pickerQuery = { artist, title };
      pickerCandidates = res.candidates;
    } else {
      Spicetify.showNotification?.(`No USDB matches for “${title}”`);
    }
  } catch (err) {
    const msg =
      err instanceof TypeError
        ? "Karaoke helper not running — start it with `bun run helper`"
        : `Search failed: ${err instanceof Error ? err.message : String(err)}`;
    Spicetify.showNotification?.(msg, true);
  } finally {
    resolving = false;
  }

  if (visible) renderOverlay();
}

// ── Bootstrap ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Wait until Spotify's app is FULLY mounted before singify touches anything.
  // Gating only on React/ReactDOM/Player (all ready mid-mount) made singify act
  // during the initial render, which tipped other extensions' components into
  // rendering before their React providers existed and white-screened the whole
  // client (their hooks threw "must be used within <Provider>"). Well-behaved
  // extensions (adblock, playNext) wait for Spicetify.Platform — the app-ready
  // signal — so we do the same, plus the shell DOM, then settle a beat.
  const ready = (): boolean =>
    !!Spicetify?.Player?.addEventListener &&
    !!Spicetify?.React &&
    !!Spicetify?.ReactDOM &&
    !!(Spicetify as unknown as { Platform?: unknown }).Platform &&
    !!document.querySelector(
      ".Root__nav-bar, .main-topBar-container, .Root__main-view"
    );
  while (!ready()) {
    await new Promise((r) => setTimeout(r, 100));
  }
  await new Promise((r) => setTimeout(r, 500));

  Spicetify.Player.addEventListener("onprogress", onProgress);
  Spicetify.Player.addEventListener("onplaypause", onPlayPause);
  Spicetify.Player.addEventListener("songchange", () => void onSongChange());

  // Topbar entry point for the menu — the same door as the K hotkey. Typed
  // loosely — Spicetify.Topbar isn't in our .d.ts and may be absent on old builds.
  const S = Spicetify as unknown as {
    Topbar?: {
      Button: new (
        label: string,
        icon: string,
        onClick: () => void,
        disabled?: boolean
      ) => unknown;
    };
  };
  if (S.Topbar?.Button) {
    new S.Topbar.Button("Singify sessions", "gamepad", () => openHome());
  }

  document.addEventListener("keydown", (e) => {
    // Hotkeys, but never while typing in a field.
    const target = e.target as HTMLElement | null;
    const typing =
      target &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable);
    if (typing) return;

    if (e.key === "k" || e.key === "K") {
      openHome(); // the menu — same as the Topbar button
    } else if (e.key === "q" || e.key === "Q") {
      openSing(); // straight to Quick Sing on the current track
    } else if (e.key === "Escape") {
      if (visible) setVisible(false); // close the overlay
    } else if (e.key === "[") {
      setOffset(offsetMs - OFFSET_STEP); // lyrics 20 ms later
    } else if (e.key === "]") {
      setOffset(offsetMs + OFFSET_STEP); // lyrics 20 ms earlier
    } else if (e.key === "\\") {
      setOffset(0); // reset sync
    } else if (e.key === "m" || e.key === "M") {
      void toggleMics();
    } else if (e.key === "l" || e.key === "L") {
      loadLocalChart(); // pick an UltraStar .txt (no USDB needed)
    } else if (e.key === "p" || e.key === "P") {
      punchSync(); // tap on the first sung word to snap the offset
    } else if (e.key === "r" || e.key === "R") {
      void reSearch(); // force a fresh USDB search + picker for this track
    } else if (e.key === "-") {
      setSensitivity(sensitivity - 5); // less sensitive (noisy room)
    } else if (e.key === "=") {
      setSensitivity(sensitivity + 5); // more sensitive (quiet room)
    }
  });

  // Prime with whatever is already playing.
  void onSongChange();
}

void main();
