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
import { resolveForTrack } from "./resolver";
import type { ParsedSong } from "./ultrastar-parser";

// ── Playback clock (interpolated) ────────────────────────────────────────────

let lastKnownMs = 0;
let lastKnownAt = 0;
let paused = false;

function getCurrentMs(): number {
  if (paused) return lastKnownMs;
  return lastKnownMs + (performance.now() - lastKnownAt);
}

function onProgress(e: SpicetifyPlayerEvent): void {
  lastKnownMs = Number(e.data) || 0;
  lastKnownAt = performance.now();
}

function onPlayPause(): void {
  // Re-anchor so the interpolation doesn't jump on resume.
  lastKnownMs = getCurrentMs();
  lastKnownAt = performance.now();
  paused = !!Spicetify.Player.data?.isPaused;
}

// ── Overlay + render ─────────────────────────────────────────────────────────

let overlay: HTMLDivElement | null = null;
let root: { render(el: unknown): void; unmount(): void } | null = null;
let currentSong: ParsedSong | null = null;
let visible = false;

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
  if (!currentSong) {
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
    return;
  }
  root.render(
    React.createElement(KaraokeView, {
      song: currentSong,
      getPositionMs: getCurrentMs,
      fullscreen: true,
    })
  );
}

function setVisible(next: boolean): void {
  visible = next;
  const el = ensureOverlay();
  el.style.display = visible ? "block" : "none";
  if (visible) renderOverlay();
}

// ── Song resolution ──────────────────────────────────────────────────────────

async function onSongChange(): Promise<void> {
  const item = Spicetify.Player.data?.item ?? Spicetify.Player.data?.track;
  if (!item?.uri) return;
  const title = item.name ?? "";
  const artist = item.artists?.[0]?.name ?? "";

  currentSong = null;
  if (visible) renderOverlay();

  try {
    const res = await resolveForTrack(item.uri, artist, title);
    if (res.status === "cached" || res.status === "downloaded") {
      currentSong = res.song;
    } else if (res.status === "needsPicker") {
      // TODO(stage 2): render picker UI from res.candidates → confirmPick().
      Spicetify.showNotification?.(
        `Karaoke: ${res.candidates.length} matches — picker not wired yet`
      );
    } else {
      Spicetify.showNotification?.(`No karaoke chart for "${title}"`);
    }
  } catch (err) {
    // TODO(stage 2): on SessionExpiredError, re-login with stored credentials
    // and retry once.
    console.error("[singify] resolve failed:", err);
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

  document.addEventListener("keydown", (e) => {
    // `K` toggles the karaoke overlay (avoid when typing in a field).
    const target = e.target as HTMLElement | null;
    const typing =
      target &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable);
    if (!typing && (e.key === "k" || e.key === "K")) {
      setVisible(!visible);
    }
  });

  // Prime with whatever is already playing.
  void onSongChange();
}

void main();
