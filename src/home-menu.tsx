/**
 * home-menu.tsx — the session/menu home screen.
 *
 * Opened from the Spicetify Topbar button (K still goes straight to Quick Sing).
 * This is the entry point for the multi-round session flow; for now it offers
 * Quick Sing (today's behaviour) and Start a Session (wired in the next
 * milestone). A pure view — the adapter hands it the current track + callbacks.
 */

export interface HomeMenuProps {
  /** The track Spotify is currently on, or null if nothing's playing. */
  track: { artist: string; title: string } | null;
  onQuickSing: () => void;
  onStartSession: () => void;
}

const ACCENT = "#1ed760";

export function HomeMenu(props: HomeMenuProps) {
  const React = Spicetify.React;
  const { track, onQuickSing, onStartSession } = props;

  const card: React.CSSProperties = {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: 6,
    width: "min(560px, 82vw)",
    padding: "22px 26px",
    borderRadius: 16,
    border: "1px solid rgba(255,255,255,0.08)",
    background: "rgba(255,255,255,0.04)",
    color: "#fff",
    cursor: "pointer",
    textAlign: "left",
    transition: "border-color 120ms ease, background 120ms ease",
  };
  const title: React.CSSProperties = { fontSize: 30, fontWeight: 800, lineHeight: 1 };
  const sub: React.CSSProperties = {
    fontSize: 16,
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
        gap: 20,
        height: "100vh",
        fontFamily: "var(--font-family, 'Spotify Circular', system-ui, sans-serif)",
      }}
    >
      <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: 2, color: ACCENT }}>
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

      <div style={{ fontSize: 13, color: "rgba(255,255,255,0.4)", marginTop: 6 }}>
        K quick-sing · M mic · P punch-sync · R re-choose · L load file · [ ] offset
      </div>
    </div>
  );
}
