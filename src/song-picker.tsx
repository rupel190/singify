/**
 * song-picker.tsx — candidate chooser for ambiguous USDB matches.
 *
 * When resolveForTrack returns { status: "needsPicker", candidates }, this lists
 * the ranked candidates (best-first) and lets the user pick one. It is purely
 * presentational: the host wires onPick → confirmPick and drives the async
 * download by passing `pendingId` / `error` back in. That keeps this component
 * free of any network/credentials concern and runnable unchanged in both the
 * browser harness (mock candidates) and inside Spotify.
 *
 * Like KaraokeView, it reads Spicetify.React so the one file serves both hosts.
 */

import type { USDBSong } from "./usdb";

export interface SongPickerProps {
  candidates: USDBSong[];
  /** What we searched for — shown in the header for context. */
  query?: { artist?: string; title?: string };
  /** id of the candidate currently downloading, if any (disables the list). */
  pendingId?: number | null;
  /** Error message to surface (e.g. a failed download). */
  error?: string | null;
  onPick: (candidate: USDBSong) => void;
  onCancel: () => void;
}

const C = {
  scrim: "rgba(8, 8, 12, 0.6)",
  card: "#16161c",
  border: "#2a2a33",
  rowHover: "#1e1e26",
  chip: "#22222b",
  text: "#f2f2f5",
  sub: "#9a9aa6",
  green: "#1ed760",
  greenInk: "#08210f",
  golden: "#e6b422",
  danger: "#ff6b6b",
};

export function SongPicker(props: SongPickerProps) {
  const { candidates, query, pendingId, error, onPick, onCancel } = props;
  const busy = pendingId != null;
  const subtitle = [query?.artist, query?.title].filter(Boolean).join(" — ");

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: "100%",
        height: "100%",
        minHeight: 360,
        padding: 20,
        boxSizing: "border-box",
        background: C.scrim,
        fontFamily: "var(--font-family, 'Spotify Circular', system-ui, sans-serif)",
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          width: "min(680px, 100%)",
          maxHeight: "100%",
          background: C.card,
          border: `1px solid ${C.border}`,
          borderRadius: 14,
          overflow: "hidden",
          boxShadow: "0 20px 60px rgba(0,0,0,0.5)",
        }}
      >
        <div style={{ padding: "18px 20px 12px" }}>
          <div style={{ color: C.text, fontSize: 20, fontWeight: 700 }}>
            Choose a karaoke chart
          </div>
          {subtitle && (
            <div style={{ color: C.sub, fontSize: 13, marginTop: 3 }}>
              {candidates.length} matches for {subtitle}
            </div>
          )}
        </div>

        {error && (
          <div
            style={{
              margin: "0 20px 8px",
              padding: "8px 12px",
              borderRadius: 8,
              background: "rgba(255,107,107,0.12)",
              color: C.danger,
              fontSize: 13,
            }}
          >
            {error}
          </div>
        )}

        <div style={{ overflowY: "auto", padding: "4px 12px 12px" }}>
          {candidates.map((c, i) => (
            <PickerRow
              key={c.id}
              candidate={c}
              best={i === 0}
              pending={pendingId === c.id}
              disabled={busy}
              onPick={onPick}
            />
          ))}
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            padding: "12px 20px",
            borderTop: `1px solid ${C.border}`,
          }}
        >
          <button
            onClick={onCancel}
            disabled={busy}
            style={{
              background: "transparent",
              color: C.sub,
              border: `1px solid ${C.border}`,
              borderRadius: 20,
              padding: "8px 18px",
              font: "600 13px system-ui",
              cursor: busy ? "default" : "pointer",
              opacity: busy ? 0.5 : 1,
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function PickerRow(props: {
  candidate: USDBSong;
  best: boolean;
  pending: boolean;
  disabled: boolean;
  onPick: (candidate: USDBSong) => void;
}) {
  const { useState } = Spicetify.React;
  const { candidate: c, best, pending, disabled, onPick } = props;
  const [hover, setHover] = useState(false);
  const clickable = !disabled;

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={() => clickable && onPick(c)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "10px 12px",
        borderRadius: 10,
        cursor: clickable ? "pointer" : "default",
        background: hover && clickable ? C.rowHover : "transparent",
        opacity: disabled && !pending ? 0.45 : 1,
        transition: "background 90ms ease, opacity 120ms ease",
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            color: C.text,
            fontSize: 15,
            fontWeight: 600,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {c.title || "(untitled)"}
          {best && (
            <span
              style={{
                flex: "none",
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: 0.4,
                color: C.greenInk,
                background: C.green,
                borderRadius: 6,
                padding: "2px 6px",
              }}
            >
              BEST MATCH
            </span>
          )}
        </div>
        <div style={{ color: C.sub, fontSize: 13, marginTop: 2 }}>
          {c.artist || "Unknown artist"}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
          {c.edition && <Chip label={c.edition} />}
          {c.language && <Chip label={c.language} />}
          <Chip label={`★ ${c.rating.toFixed(1)}`} />
          <Chip label={`${c.views.toLocaleString()} views`} />
          {c.golden && <Chip gold label="✦ golden" />}
        </div>
      </div>

      <div style={{ flex: "none", width: 104, textAlign: "right" }}>
        {pending ? (
          <span style={{ color: C.green, fontSize: 13, fontWeight: 600 }}>Downloading…</span>
        ) : (
          <span
            style={{
              display: "inline-block",
              color: clickable && hover ? C.greenInk : C.text,
              background: clickable && hover ? C.green : "transparent",
              border: `1px solid ${clickable && hover ? C.green : C.border}`,
              borderRadius: 20,
              padding: "6px 14px",
              fontSize: 13,
              fontWeight: 600,
              transition: "background 90ms ease, color 90ms ease",
            }}
          >
            Pick
          </span>
        )}
      </div>
    </div>
  );
}

function Chip(props: { label: string; gold?: boolean }) {
  return (
    <span
      style={{
        fontSize: 11,
        color: props.gold ? C.golden : C.sub,
        background: C.chip,
        border: `1px solid ${props.gold ? "rgba(230,180,34,0.4)" : C.border}`,
        borderRadius: 6,
        padding: "2px 8px",
      }}
    >
      {props.label}
    </span>
  );
}
