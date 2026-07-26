/**
 * mic-meter.tsx — a live input-level bar with the detection gate drawn ON it.
 *
 * The fill is the mic's current level (post-gain RMS); the vertical handle is the
 * gate threshold. Level and gate share ONE perceptual scale (pitch.rmsToMeter),
 * so you watch your voice rise and drag the gate to sit just above the room
 * noise — the fill turns "live" green once it clears the gate. Drag anywhere on
 * the bar to move the gate. Shared by the setup screen (preview mics) and the
 * in-game HUD (the running mics).
 *
 * Uses Spicetify.React so it runs unchanged in Spotify and the browser harness.
 */

import {
  rmsToMeter,
  meterToRms,
  sensitivityToThreshold,
  thresholdToSensitivity,
} from "./pitch";

export interface MicMeterProps {
  /** Current input level (post-gain RMS, ~0..0.4). Polled every animation frame. */
  getLevel: () => number;
  /** Shared gate as 0..100 sensitivity (higher = lower gate = quieter passes). */
  sensitivity: number;
  /** Drag callback with the new sensitivity (0..100); omit for a read-only meter. */
  onSensitivity?: (n: number) => void;
  /** Optional caption above the bar (e.g. a player name). */
  label?: string;
  width?: number | string;
  height?: number;
  /** Fill tint once the level clears the gate (defaults to green). */
  color?: string;
}

export function MicMeter(props: MicMeterProps) {
  const React = Spicetify.React;
  const { useState, useEffect, useRef, useCallback } = React;
  const {
    getLevel,
    sensitivity,
    onSensitivity,
    label,
    width = "100%",
    height = 16,
    color = "#1ed760",
  } = props;

  // Poll the live level on its own rAF — one re-render per frame, cheap DOM.
  const [level, setLevel] = useState(0);
  const raf = useRef(0);
  useEffect(() => {
    const tick = () => {
      setLevel(getLevel());
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [getLevel]);

  const levelFrac = rmsToMeter(level);
  const gateFrac = rmsToMeter(sensitivityToThreshold(sensitivity));
  const passing = levelFrac >= gateFrac;

  // Drag → set the gate. A bar fraction maps to an RMS (meterToRms), then to the
  // sensitivity value the app persists (thresholdToSensitivity).
  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);
  const setFromClientX = useCallback(
    (clientX: number) => {
      const el = trackRef.current;
      if (!el || !onSensitivity) return;
      const r = el.getBoundingClientRect();
      const frac = r.width > 0 ? (clientX - r.left) / r.width : 0;
      onSensitivity(Math.round(thresholdToSensitivity(meterToRms(frac))));
    },
    [onSensitivity]
  );

  const onDown = (e: { pointerId: number; clientX: number; currentTarget: unknown }) => {
    if (!onSensitivity) return;
    dragging.current = true;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    setFromClientX(e.clientX);
  };
  const onMove = (e: { clientX: number }) => {
    if (dragging.current) setFromClientX(e.clientX);
  };
  const onUp = (e: { pointerId: number; currentTarget: unknown }) => {
    dragging.current = false;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3, width }}>
      {label != null && (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontSize: 12,
            fontWeight: 700,
            color: "rgba(255,255,255,0.6)",
          }}
        >
          <span>{label}</span>
          <span style={{ color: "rgba(255,255,255,0.4)", fontVariantNumeric: "tabular-nums" }}>
            gate {Math.round(sensitivity)}%
          </span>
        </div>
      )}
      <div
        ref={trackRef}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        style={{
          position: "relative",
          height,
          borderRadius: height / 2,
          background: "rgba(255,255,255,0.08)",
          cursor: onSensitivity ? "ew-resize" : "default",
          overflow: "hidden",
          touchAction: "none",
        }}
      >
        {/* live level fill — muted until it clears the gate, then goes live. */}
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: `${levelFrac * 100}%`,
            background: passing ? color : "rgba(255,255,255,0.22)",
            transition: "width 55ms linear, background 90ms linear",
          }}
        />
        {/* gate marker — the threshold line the level must beat to be scored. */}
        <div
          style={{
            position: "absolute",
            left: `${gateFrac * 100}%`,
            top: 0,
            bottom: 0,
            width: 3,
            marginLeft: -1.5,
            background: "#fff",
            boxShadow: "0 0 5px rgba(0,0,0,0.7)",
            pointerEvents: "none",
          }}
        />
      </div>
    </div>
  );
}
