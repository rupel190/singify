/**
 * index.ts — Spicetify extension entry point.
 *
 * Waits for Spicetify, tracks playback position (interpolated between
 * onprogress events), resolves an UltraStar chart for the current track, and
 * renders <KaraokeView> into a fullscreen overlay toggled with the `K` hotkey.
 *
 * NOTE (real-runtime, stage 2): the cache layer (src/cache.ts) uses node:fs to
 * persist songs under ~/spicetify-karaoke/. That requires a Node-capable
 * context; in a sandboxed renderer it must be reached via a preload bridge or
 * the Electron main process. For browser-harness development we exercise
 * <KaraokeView> directly with a fixture song and never touch the cache.
 */

import { KaraokeView } from "./karaoke-view";
import { SongPicker } from "./song-picker";
import { HomeMenu } from "./home-menu";
import { startMicPitch, type MicPitch } from "./mic";
import { resolveForTrack, confirmPick } from "./resolver-client";
import { sensitivityToThreshold } from "./pitch";
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
      padding: "8px 16px",
      borderRadius: "18px",
      background: "rgba(10, 10, 14, 0.92)",
      color: "#fff",
      font: "600 13px 'Spotify Circular', system-ui, sans-serif",
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
// M toggles the mic. read() is polled by <KaraokeView> each frame via
// getLivePitchMidi; all the analysis is the pure detectPitch().

async function toggleMic(): Promise<void> {
  if (micPitch) {
    micPitch.stop();
    micPitch = null;
    Spicetify.showNotification?.("Mic off");
    if (visible) renderOverlay(); // drop scoring/HUD
    return;
  }
  try {
    micPitch = await startMicPitch({
      rmsThreshold: sensitivityToThreshold(sensitivity),
    });
    Spicetify.showNotification?.("🎤 Mic on");
    if (visible) renderOverlay(); // start a fresh scored attempt
  } catch (err) {
    Spicetify.showNotification?.("Mic access denied", true);
    console.error("[singify] mic failed:", err);
  }
}

function getLivePitchMidi(): number | null {
  return micPitch?.read()?.midi ?? null;
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

function loadSensitivity(): number {
  const v = Number(localStorage.getItem(SENS_KEY));
  return Number.isFinite(v) && v >= 0 && v <= 100 ? v : 60;
}

let sensitivity = loadSensitivity();

function setSensitivity(next: number): void {
  sensitivity = Math.min(100, Math.max(0, Math.round(next)));
  try {
    localStorage.setItem(SENS_KEY, String(sensitivity));
  } catch {
    /* storage blocked — keep the in-memory value */
  }
  micPitch?.setOptions({ rmsThreshold: sensitivityToThreshold(sensitivity) });
  showReadout(`🎤 Sensitivity ${sensitivity}%`);
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
// Which screen the overlay shows. "sing" is the karaoke surface (K / Quick Sing,
// today's behaviour); "home" is the session menu (opened from the Topbar button).
type Screen = "home" | "sing";
let screen: Screen = "sing";
// Set when a chart is loaded manually (L hotkey) instead of resolved from USDB —
// lets you sing along in Spotify without a USDB account. While set, songchange
// won't overwrite the chart (reload the client to go back to auto-resolve).
let manualChart = false;

// Picker state — set when resolveForTrack returns candidates to choose from.
let currentTrackId: string | null = null;
let pickerQuery: { artist?: string; title?: string } | null = null;
let pickerCandidates: USDBSong[] | null = null;
let pickPending: number | null = null;
let pickError: string | null = null;

let micPitch: MicPitch | null = null;

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

  if (screen === "home") {
    const item = Spicetify.Player.data?.item ?? Spicetify.Player.data?.track;
    const track = item
      ? { artist: item.artists?.[0]?.name ?? "", title: item.name ?? "" }
      : null;
    root.render(
      React.createElement(HomeMenu, {
        track,
        onQuickSing: () => {
          screen = "sing";
          renderOverlay();
        },
        onStartSession: () => {
          // Milestone 2 wires the real session flow here.
          Spicetify.showNotification?.("Sessions land in the next build 🎶");
        },
      })
    );
    return;
  }

  if (currentSong) {
    root.render(
      React.createElement(KaraokeView, {
        song: currentSong,
        getPositionMs: getCurrentMs,
        getLivePitchMidi,
        showScore: micPitch != null, // score while the mic is live
        onReplay,
        fullscreen: true,
      })
    );
    return;
  }

  if (pickerCandidates) {
    root.render(
      React.createElement(SongPicker, {
        candidates: pickerCandidates,
        query: pickerQuery ?? undefined,
        pendingId: pickPending,
        error: pickError,
        onPick,
        onCancel,
      })
    );
    return;
  }

  root.render(
    React.createElement(
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
    )
  );
}

function setVisible(next: boolean): void {
  visible = next;
  const el = ensureOverlay();
  el.style.display = visible ? "block" : "none";
  if (visible) renderOverlay();
}

// K → the karaoke surface (Quick Sing); toggles closed if already there.
function openSing(): void {
  if (visible && screen === "sing") {
    setVisible(false);
    return;
  }
  screen = "sing";
  setVisible(true);
}

// Topbar button → the session menu; toggles closed if already there.
function openHome(): void {
  if (visible && screen === "home") {
    setVisible(false);
    return;
  }
  screen = "home";
  setVisible(true);
}

// ── Song resolution ──────────────────────────────────────────────────────────

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
  if (visible) renderOverlay();

  try {
    const res = await resolveForTrack(item.uri, artist, title);
    if (
      res.status === "cached" ||
      res.status === "downloaded" ||
      res.status === "local"
    ) {
      currentSong = res.song;
    } else if (res.status === "needsPicker") {
      pickerQuery = { artist, title };
      pickerCandidates = res.candidates;
      if (!visible) {
        Spicetify.showNotification?.(
          `Karaoke: ${res.candidates.length} matches for “${title}” — press K to choose`
        );
      }
    } else {
      Spicetify.showNotification?.(`No karaoke chart for “${title}”`);
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
  }

  if (visible) renderOverlay();
}

// ── Bootstrap ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  while (
    !Spicetify?.Player?.addEventListener ||
    !Spicetify?.React ||
    !Spicetify?.ReactDOM
  ) {
    await new Promise((r) => setTimeout(r, 100));
  }

  Spicetify.Player.addEventListener("onprogress", onProgress);
  Spicetify.Player.addEventListener("onplaypause", onPlayPause);
  Spicetify.Player.addEventListener("songchange", () => void onSongChange());

  // Topbar entry point for sessions (K still goes straight to Quick Sing). Typed
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
      openSing(); // Quick Sing the current track
    } else if (e.key === "Escape") {
      if (visible) setVisible(false); // close the overlay
    } else if (e.key === "[") {
      setOffset(offsetMs - OFFSET_STEP); // lyrics 20 ms later
    } else if (e.key === "]") {
      setOffset(offsetMs + OFFSET_STEP); // lyrics 20 ms earlier
    } else if (e.key === "\\") {
      setOffset(0); // reset sync
    } else if (e.key === "m" || e.key === "M") {
      void toggleMic();
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
