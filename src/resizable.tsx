/**
 * resizable.tsx — a corner handle that sizes one UI element, remembered per
 * element. Screens from FHD to 4K want different sizes for different things
 * (a tiny mic panel, giant HUD buttons), so each element gets its own knob
 * instead of one global UI_SCALE.
 *
 * Two modes:
 *  - "zoom": CSS zoom on the element — type, padding and controls together.
 *    Drag the bottom-right triangle out to grow, in to shrink.
 *  - "height": the element's share of its parent's height (the note highway vs
 *    the lyrics). Bottom-aligned elements grow upward, so the handle sits top-right.
 * Double-click a handle to reset that element.
 *
 * Values live in localStorage under `${UI_SIZE_PREFIX}<id>`. A change fires a
 * `singify:layout` window event so the Spotify adapter can mirror it to disk;
 * this file stays free of persistence so the browser harness can use it too.
 */

import { UI_SIZE_PREFIX } from "./storage-keys";

export type ResizeMode = "zoom" | "height";

const LIMITS: Record<ResizeMode, [number, number]> = { zoom: [0.4, 3], height: [20, 100] };

export function readSize(id: string, fallback: number): number {
  try {
    const v = Number(localStorage.getItem(UI_SIZE_PREFIX + id));
    return Number.isFinite(v) && v > 0 ? v : fallback;
  } catch {
    return fallback;
  }
}

function writeSize(id: string, value: number | null): void {
  try {
    if (value == null) localStorage.removeItem(UI_SIZE_PREFIX + id);
    else localStorage.setItem(UI_SIZE_PREFIX + id, String(Math.round(value * 1000) / 1000));
  } catch {
    return;
  }
  window.dispatchEvent(new Event("singify:layout"));
}

/** Forget every element's size (Ctrl+0). Callers remount the UI to re-read them. */
export function resetAllSizes(): void {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith(UI_SIZE_PREFIX)) localStorage.removeItem(k);
  } catch {
    return;
  }
  window.dispatchEvent(new Event("singify:layout"));
}

/** Handles stay faint until you hover the element they size. */
function ensureStyles(): void {
  if (typeof document === "undefined" || document.getElementById("singify-resizable")) return;
  const st = document.createElement("style");
  st.id = "singify-resizable";
  st.textContent =
    ".singify-rs>.singify-rs-handle{opacity:0;transition:opacity 150ms}" +
    ".singify-rs:hover>.singify-rs-handle{opacity:.55}" +
    ".singify-rs>.singify-rs-handle:hover,.singify-rs>.singify-rs-handle.dragging{opacity:1}";
  document.head.appendChild(st);
}

export function Resizable(props: {
  id: string;
  mode?: ResizeMode;
  /** Default value: zoom factor (1) or height percent. */
  initial?: number;
  children?: import("react").ReactNode;
  /** Extra styles for the outer box (flex sizing, alignment…). */
  style?: Record<string, unknown>;
  /** Zoom mode: the content fills the box's height (full-screen, self-centring screens). */
  fill?: boolean;
  /** Where the zoom handle sits: bottom-right (default) or top-right (drag up = bigger). */
  corner?: "br" | "tr";
}) {
  const React = Spicetify.React;
  const { useState, useRef } = React;
  const { id, mode = "zoom", initial = mode === "zoom" ? 1 : 75, children, style, fill } = props;
  const top = mode === "height" || props.corner === "tr"; // handle on the top edge
  ensureStyles();

  const [value, setValue] = useState(() => readSize(id, initial));
  const boxRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ x: number; y: number; start: number; w: number; h: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [lo, hi] = LIMITS[mode];

  const onDown = (e: { pointerId: number; clientX: number; clientY: number; currentTarget: unknown; preventDefault(): void; stopPropagation(): void }) => {
    const box = boxRef.current;
    if (!box) return;
    e.preventDefault();
    e.stopPropagation();
    const r = box.getBoundingClientRect();
    const parent = box.parentElement?.getBoundingClientRect();
    drag.current = { x: e.clientX, y: e.clientY, start: value, w: r.width, h: mode === "height" ? parent?.height ?? r.height : r.height };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    setDragging(true);
  };
  const onMove = (e: { clientX: number; clientY: number }) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    // Zoom follows whichever way you drag more, relative to the element's size,
    // so a wide-and-short element (the lyrics) still responds to a vertical drag.
    const rx = dx / Math.max(80, d.w);
    const ry = (top ? -dy : dy) / Math.max(80, d.h); // a top handle grows upward
    const next =
      mode === "zoom"
        ? d.start * (1 + (Math.abs(rx) > Math.abs(ry) ? rx : ry))
        : d.start + ry * 100; // dragging up makes it taller
    setValue(Math.min(hi, Math.max(lo, next)));
  };
  const onUp = (e: { pointerId: number; currentTarget: unknown }) => {
    if (!drag.current) return;
    drag.current = null;
    setDragging(false);
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    writeSize(id, value);
  };
  const reset = () => {
    setValue(initial);
    writeSize(id, null);
  };

  const handleSize = 22;
  const handle = (
    <div
      className={"singify-rs-handle" + (dragging ? " dragging" : "")}
      title="Drag to resize · double-click to reset"
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onDoubleClick={reset}
      // Pointer capture alone doesn't stop the mousedown's text selection.
      onMouseDown={(e: { preventDefault(): void }) => e.preventDefault()}
      style={{
        position: "absolute",
        right: 2,
        [top ? "top" : "bottom"]: 2,
        width: handleSize,
        height: handleSize,
        cursor: mode === "height" ? "ns-resize" : top ? "nesw-resize" : "nwse-resize",
        touchAction: "none",
        zIndex: 20,
        // A right-angled triangle tucked into the corner.
        background: `linear-gradient(${top ? "45deg" : "135deg"}, transparent 50%, rgba(255,255,255,0.75) 50%)`,
        borderRadius: 3,
      }}
    />
  );

  if (mode === "height") {
    return (
      <div
        ref={boxRef}
        className="singify-rs"
        style={{ position: "relative", height: `${value}%`, ...style }}
      >
        {children}
        {handle}
      </div>
    );
  }
  return (
    <div ref={boxRef} className="singify-rs" style={{ position: "relative", ...style }}>
      <div style={{ zoom: value, height: fill ? "100%" : undefined }}>{children}</div>
      {handle}
    </div>
  );
}
