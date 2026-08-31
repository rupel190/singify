/**
 * home-menu.tsx — the session/menu home screen.
 *
 * Opened with `K` or the Spicetify Topbar button; `Q` skips it and goes straight
 * to Quick Sing.
 * This is the entry point for the multi-round session flow; for now it offers
 * Quick Sing (today's behaviour) and Start a Session (wired in the next
 * milestone). A pure view — the adapter hands it the current track + callbacks.
 */

export interface HomeMenuProps {
  /** The track Spotify is currently on, or null if nothing's playing. */
  track: { artist: string; title: string } | null;
  onQuickSing: () => void;
  onStartSession: () => void;
  onStats: () => void;
}

const ACCENT = "#1ed760";

export function HomeMenu(props: HomeMenuProps) {
  const React = Spicetify.React;
  const { track, onQuickSing, onStartSession, onStats } = props;

  const card: React.CSSProperties = {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: 10,
    width: "min(640px, 88vw)",
    padding: "30px 34px",
    borderRadius: 20,
    border: "1px solid rgba(255,255,255,0.08)",
    background: "rgba(255,255,255,0.04)",
    color: "#fff",
    cursor: "pointer",
    textAlign: "left",
    transition: "border-color 120ms ease, background 120ms ease",
  };
  const title: React.CSSProperties = { fontSize: 45, fontWeight: 800, lineHeight: 1 };
  const sub: React.CSSProperties = {
    fontSize: 24,
    fontWeight: 500,
    color: "rgba(255,255,255,0.6)",
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 28,
        // ~half its former size (was 2×) — the menu opened bigger than it needed
        // to. Multiplies with the root's UI_SCALE; percentages resolve in the
        // zoomed space, so 100% still means "fill the parent".
        zoom: 1,
        height: "100%",
        overflowY: "auto",
        fontFamily: "var(--font-family, 'Spotify Circular', system-ui, sans-serif)",
      }}
    >
      <div style={{ fontSize: 33, fontWeight: 800, letterSpacing: 3, color: ACCENT }}>
        SINGIFY
      </div>

      <button
        onClick={onQuickSing}
        style={{ ...card, borderColor: `${ACCENT}66`, background: `${ACCENT}14` }}
      >
        <span style={{ ...title, color: ACCENT }}>🎤 Quick Sing</span>
        <span style={sub}>
          {track ? `${track.artist} — ${track.title}` : "play something to sing along"}
        </span>
      </button>

      <button onClick={onStartSession} style={card}>
        <span style={title}>▶ Start a Session</span>
        <span style={sub}>multi-round · scores carry across songs · big finish</span>
      </button>

      <button
        onClick={onStats}
        style={{
          background: "transparent",
          color: "rgba(255,255,255,0.72)",
          border: "1px solid rgba(255,255,255,0.14)",
          borderRadius: 14,
          padding: "12px 22px",
          fontSize: 22,
          fontWeight: 700,
          cursor: "pointer",
        }}
      >
        📊 Stats
      </button>

      <div style={{ fontSize: 26, color: "rgba(255,255,255,0.5)", marginTop: 10 }}>
        Q quick-sing · M mic · P punch-sync · R re-choose · L load file · [ ] offset
      </div>
    </div>
  );
}
