/**
 * session-view.tsx — the session screens (pure views; the adapter drives state).
 *
 *   SessionSetup        — choose round count + confirm mic, then Start
 *   SessionHud          — compact overlay during a round (progress, total, mics)
 *   RoundEnd            — between rounds: the round you just finished + what's next
 *   SessionResultScreen — the big aggregate finish (per-round leaderboard + total)
 *
 * All multiplayer-shaped: mics and per-round scores are lists (length 1 today).
 */

import type { RoundResult, SessionSummary, SessionTrack } from "./session";
import type { PlaylistRef } from "./playlist-source";

const ACCENT = "#1ed760";
const GOLD = "#e6b422";

/** One microphone's live state — a list so multi-mic slots in later. */
export interface MicInfo {
  label: string; // e.g. "🎤" or a player name
  sensitivity: number; // 0..100
  active: boolean;
}

function stars(n: number): string {
  return "★".repeat(n) + "☆".repeat(Math.max(0, 5 - n));
}

// ── Setup ────────────────────────────────────────────────────────────────────

export function SessionSetup(props: {
  // Playlist mode — the primary path: sing straight through a Spotify playlist.
  playlists: PlaylistRef[];
  loadingPlaylists: boolean;
  onStartPlaylist: (ref: PlaylistRef) => void;
  /** The playlist the user is already playing, offered as a one-tap start. */
  current?: PlaylistRef | null;
  // Free-play mode — sing N songs off whatever's queued.
  rounds: number;
  onRounds: (n: number) => void;
  onStart: () => void;
  onCancel: () => void;
  micOn: boolean;
  // Hotseat roster — players take turns on the one mic. onPlayers replaces it.
  players: string[];
  onPlayers: (names: string[]) => void;
}) {
  const React = Spicetify.React;
  const {
    playlists,
    loadingPlaylists,
    onStartPlaylist,
    current,
    rounds,
    onRounds,
    onStart,
    onCancel,
    micOn,
    players,
    onPlayers,
  } = props;

  const MAX_PLAYERS = 6; // hotseat can seat a few; the mic just passes around
  const setName = (i: number, name: string) =>
    onPlayers(players.map((p, j) => (j === i ? name : p)));
  const addPlayer = () =>
    players.length < MAX_PLAYERS && onPlayers([...players, `P${players.length + 1}`]);
  const removePlayer = (i: number) =>
    players.length > 1 && onPlayers(players.filter((_, j) => j !== i));

  const chip = (n: number): React.CSSProperties => ({
    padding: "8px 16px",
    borderRadius: 12,
    fontSize: 20,
    fontWeight: 800,
    cursor: "pointer",
    border: `1px solid ${rounds === n ? ACCENT : "rgba(255,255,255,0.12)"}`,
    background: rounds === n ? `${ACCENT}22` : "rgba(255,255,255,0.04)",
    color: rounds === n ? ACCENT : "#fff",
  });

  const sectionLabel: React.CSSProperties = {
    alignSelf: "flex-start",
    fontSize: 13,
    fontWeight: 700,
    letterSpacing: 1,
    textTransform: "uppercase",
    color: "rgba(255,255,255,0.45)",
  };

  return (
    <Center>
      <div style={{ fontSize: 34, fontWeight: 800 }}>New Session</div>
      <div
        style={{
          fontSize: 15,
          color: micOn ? ACCENT : "#ff9e6b",
          fontWeight: 600,
        }}
      >
        {micOn ? "🎤 Mic on — you'll be scored" : "🎤 Mic is off — starting turns it on"}
      </div>

      {/* Panel keeps the modes tidy in one column. */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 12,
          width: "min(560px, 84vw)",
          marginTop: 10,
        }}
      >
        {/* Roster — one player is solo; add singers for hotseat (they share the mic). */}
        <div style={sectionLabel}>
          Players {players.length > 1 && <span style={{ color: ACCENT }}>· hotseat, take turns</span>}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          {players.map((name, i) => (
            <div
              key={i}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                padding: "4px 6px 4px 10px",
                borderRadius: 10,
                background: "rgba(255,255,255,0.05)",
                border: "1px solid rgba(255,255,255,0.1)",
              }}
            >
              <span style={{ color: ACCENT, fontWeight: 800, fontSize: 13 }}>{i + 1}</span>
              <input
                value={name}
                onChange={(e) => setName(i, (e.target as HTMLInputElement).value)}
                maxLength={16}
                style={{
                  width: 96,
                  background: "transparent",
                  border: "none",
                  color: "#fff",
                  fontSize: 15,
                  fontWeight: 600,
                  outline: "none",
                }}
              />
              {players.length > 1 && (
                <button
                  onClick={() => removePlayer(i)}
                  title="Remove"
                  style={{
                    border: "none",
                    background: "transparent",
                    color: "rgba(255,255,255,0.5)",
                    cursor: "pointer",
                    fontSize: 16,
                    lineHeight: 1,
                    padding: "0 2px",
                  }}
                >
                  ×
                </button>
              )}
            </div>
          ))}
          {players.length < MAX_PLAYERS && (
            <button
              onClick={addPlayer}
              style={{
                padding: "8px 12px",
                borderRadius: 10,
                border: "1px dashed rgba(255,255,255,0.2)",
                background: "transparent",
                color: "rgba(255,255,255,0.7)",
                cursor: "pointer",
                fontSize: 14,
                fontWeight: 700,
              }}
            >
              + Add singer
            </button>
          )}
        </div>

        {current && (
          <button
            onClick={() => onStartPlaylist(current)}
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-start",
              gap: 2,
              padding: "12px 16px",
              borderRadius: 12,
              border: `1px solid ${ACCENT}66`,
              background: `${ACCENT}14`,
              color: "#fff",
              cursor: "pointer",
              textAlign: "left",
            }}
          >
            <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: ACCENT }}>
              ▶ Continue what you're playing
            </span>
            <span style={{ fontSize: 18, fontWeight: 800 }}>{current.name}</span>
          </button>
        )}

        <div style={sectionLabel}>Sing a playlist</div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            maxHeight: 320,
            overflowY: "auto",
            borderRadius: 12,
            border: "1px solid rgba(255,255,255,0.08)",
            background: "rgba(255,255,255,0.03)",
            padding: 6,
          }}
        >
          {loadingPlaylists ? (
            <PlaceholderRow text="Loading your playlists…" />
          ) : playlists.length === 0 ? (
            <PlaceholderRow text="No playlists found — use free play below." />
          ) : (
            playlists.map((p) => (
              <button
                key={p.uri}
                onClick={() => onStartPlaylist(p)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                  padding: "10px 14px",
                  borderRadius: 10,
                  border: "1px solid transparent",
                  background: "rgba(255,255,255,0.04)",
                  color: "#fff",
                  cursor: "pointer",
                  textAlign: "left",
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLElement).style.borderColor = `${ACCENT}66`;
                  (e.currentTarget as HTMLElement).style.background = `${ACCENT}14`;
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLElement).style.borderColor = "transparent";
                  (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.04)";
                }}
              >
                <span style={{ fontSize: 17, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {p.name}
                </span>
                <span style={{ fontSize: 14, color: "rgba(255,255,255,0.5)", flexShrink: 0 }}>
                  {p.count != null ? `${p.count} songs · ▶` : "▶"}
                </span>
              </button>
            ))
          )}
        </div>

        <div style={{ ...sectionLabel, marginTop: 8 }}>Or free play</div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {[3, 5, 10].map((n) => (
            <button key={n} style={chip(n)} onClick={() => onRounds(n)}>
              {n}
            </button>
          ))}
          <button style={{ ...primaryBtn(React), marginLeft: "auto" }} onClick={onStart}>
            ▶ {rounds} rounds
          </button>
        </div>
      </div>

      <button style={{ ...ghostBtn(React), marginTop: 16 }} onClick={onCancel}>
        Cancel
      </button>
    </Center>
  );
}

function PlaceholderRow(props: { text: string }) {
  return (
    <div style={{ padding: "16px 14px", fontSize: 15, color: "rgba(255,255,255,0.5)", textAlign: "center" }}>
      {props.text}
    </div>
  );
}

// ── In-round HUD ─────────────────────────────────────────────────────────────

export function SessionHud(props: {
  round: number;
  target: number;
  sessionTotal: number;
  mics: MicInfo[];
  onSkip: () => void;
  onEnd: () => void;
  /** Source playlist name, shown when the session is playlist-sourced. */
  sourceName?: string | null;
  /** Whose turn it is (hotseat), shown when there's more than one player. */
  currentSinger?: string | null;
}) {
  const React = Spicetify.React;
  const { round, target, sessionTotal, mics, onSkip, onEnd, sourceName, currentSinger } =
    props;
  const btn: React.CSSProperties = {
    padding: "5px 12px",
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 700,
    cursor: "pointer",
    border: "1px solid rgba(255,255,255,0.14)",
    background: "rgba(0,0,0,0.4)",
    color: "#fff",
  };
  return (
    <div
      style={{
        position: "absolute",
        top: 10,
        left: 12,
        zIndex: 6,
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: "8px 14px",
        borderRadius: 12,
        background: "rgba(8,8,12,0.72)",
        border: "1px solid rgba(255,255,255,0.1)",
        color: "#fff",
        fontFamily: "var(--font-family, 'Spotify Circular', system-ui, sans-serif)",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.1 }}>
        {sourceName && (
          <span
            style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: 0.5,
              color: "rgba(255,255,255,0.5)",
              maxWidth: 180,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {sourceName}
          </span>
        )}
        <span style={{ fontSize: 18, fontWeight: 800 }}>
          Round <span style={{ color: ACCENT }}>{round}</span>/{target}
        </span>
      </div>
      <div style={{ fontSize: 18, fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>
        {sessionTotal.toLocaleString()}
      </div>
      {currentSinger && (
        <div
          style={{
            fontSize: 14,
            fontWeight: 800,
            padding: "4px 10px",
            borderRadius: 8,
            color: ACCENT,
            background: `${ACCENT}1e`,
          }}
        >
          🎤 {currentSinger}'s turn
        </div>
      )}
      <div style={{ display: "flex", gap: 6 }}>
        {mics.map((m, i) => (
          <span
            key={i}
            style={{
              fontSize: 13,
              fontWeight: 700,
              padding: "3px 8px",
              borderRadius: 8,
              color: m.active ? ACCENT : "rgba(255,255,255,0.4)",
              background: m.active ? `${ACCENT}1e` : "rgba(255,255,255,0.05)",
            }}
          >
            {m.label} {m.active ? `${m.sensitivity}%` : "off"}
          </span>
        ))}
      </div>
      <button style={btn} onClick={onSkip}>
        Skip
      </button>
      <button style={btn} onClick={onEnd}>
        End
      </button>
    </div>
  );
}

// ── No chart for the current track (during a session) ────────────────────────
//
// A playlist is full of songs USDB won't have. Rather than dead-end, give the
// singer a way forward right on the stage: skip to the next track, or force a
// fresh USDB search (maybe it's there under a different title). The HUD's Skip
// does the same, but surfacing it here keeps a hands-on session flowing.

export function NoChartInSession(props: {
  title: string;
  artist: string;
  onSkip: () => void;
  onReChoose: () => void;
  /** True once we've searched and found nothing (vs still looking). */
  searched: boolean;
}) {
  const React = Spicetify.React;
  const { title, artist, onSkip, onReChoose, searched } = props;
  return (
    <Center>
      <div style={{ fontSize: 40 }}>🎤</div>
      <div style={{ fontSize: 26, fontWeight: 800 }}>
        {searched ? "No karaoke chart for this track" : "Looking for a chart…"}
      </div>
      <div style={{ fontSize: 17, color: "rgba(255,255,255,0.6)" }}>
        {artist} — {title}
      </div>
      {searched && (
        <div style={{ display: "flex", gap: 12, marginTop: 18 }}>
          <button style={primaryBtn(React)} onClick={onSkip}>
            ⏭ Skip to next song
          </button>
          <button style={ghostBtn(React)} onClick={onReChoose}>
            🔎 Re-choose (R)
          </button>
        </div>
      )}
    </Center>
  );
}

// ── Between rounds ───────────────────────────────────────────────────────────

export function RoundEnd(props: {
  justFinished: RoundResult;
  roundNumber: number;
  target: number;
  sessionTotal: number;
  onContinue: () => void;
  /** Next track in a playlist session, shown as "Up next" (null = free play). */
  upNext?: SessionTrack | null;
  /** Who sings the next round (hotseat); null when solo. */
  nextSinger?: string | null;
}) {
  const React = Spicetify.React;
  const { justFinished, roundNumber, target, sessionTotal, onContinue, upNext, nextSinger } =
    props;
  const s = justFinished.scores[0];
  const last = roundNumber >= target;
  return (
    <Center>
      <div style={{ fontSize: 22, color: "rgba(255,255,255,0.6)", fontWeight: 700 }}>
        Round {roundNumber} of {target} done
      </div>
      <div style={{ fontSize: 30, fontWeight: 800 }}>{justFinished.title}</div>
      {/* In hotseat, name who just sang this round. */}
      {s.player && s.player !== "You" && (
        <div style={{ fontSize: 16, color: "rgba(255,255,255,0.65)" }}>
          🎤 sung by <span style={{ color: "#fff", fontWeight: 700 }}>{s.player}</span>
        </div>
      )}
      <div style={{ fontSize: 22, color: GOLD }}>{stars(s.grade.stars)}</div>
      <div
        style={{ fontSize: 56, fontWeight: 800, color: ACCENT, fontVariantNumeric: "tabular-nums" }}
      >
        {s.total.toLocaleString()}
      </div>
      <div style={{ fontSize: 16, color: "rgba(255,255,255,0.6)" }}>
        Session total {sessionTotal.toLocaleString()}
      </div>
      {!last && (upNext || nextSinger) && (
        <div style={{ fontSize: 15, color: "rgba(255,255,255,0.5)", marginTop: 4 }}>
          Up next:{" "}
          {nextSinger && (
            <span style={{ color: ACCENT, fontWeight: 700 }}>🎤 {nextSinger}'s turn</span>
          )}
          {upNext && (
            <span style={{ color: "#fff", fontWeight: 600 }}>
              {nextSinger ? " · " : ""}
              {upNext.artist} — {upNext.title}
            </span>
          )}
        </div>
      )}
      <button style={{ ...primaryBtn(React), marginTop: 16 }} onClick={onContinue}>
        {last ? "See the results ▶" : nextSinger ? `${nextSinger}, you're up ▶` : upNext ? "Next song ▶" : "Next — play another song ▶"}
      </button>
    </Center>
  );
}

// ── Aggregate finish ─────────────────────────────────────────────────────────

export function SessionResultScreen(props: {
  summary: SessionSummary;
  onDone: () => void;
  onSave?: () => void;
}) {
  const React = Spicetify.React;
  const { summary, onDone, onSave } = props;
  const multiplayer = summary.players.length > 1;
  const headline = summary.players[0]; // solo headline
  // Standings: players ranked by total (winner first).
  const ranked = [...summary.players].sort((a, b) => b.total - a.total);

  const cell: React.CSSProperties = { padding: "8px 12px", fontSize: 17 };
  const head: React.CSSProperties = {
    ...cell,
    fontSize: 13,
    letterSpacing: 1,
    textTransform: "uppercase",
    color: "rgba(255,255,255,0.45)",
    fontWeight: 700,
  };

  return (
    <Center>
      <div style={{ fontSize: 22, color: "rgba(255,255,255,0.6)", fontWeight: 700 }}>
        Session complete
      </div>

      {multiplayer ? (
        <>
          {summary.winner && (
            <div style={{ fontSize: 30, fontWeight: 800, color: GOLD }}>
              👑 {summary.winner} wins
            </div>
          )}
          {/* Player standings — winner-first cards. */}
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", justifyContent: "center", marginTop: 6 }}>
            {ranked.map((pl, i) => {
              const win = pl.player === summary.winner;
              return (
                <div
                  key={pl.player}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: 2,
                    minWidth: 140,
                    padding: "14px 18px",
                    borderRadius: 14,
                    border: `1px solid ${win ? GOLD : "rgba(255,255,255,0.1)"}`,
                    background: win ? `${GOLD}14` : "rgba(255,255,255,0.03)",
                  }}
                >
                  <div style={{ fontSize: 15, fontWeight: 700, color: "rgba(255,255,255,0.6)" }}>
                    {i === 0 ? "①" : i === 1 ? "②" : i === 2 ? "③" : `#${i + 1}`} {pl.player}
                  </div>
                  <div
                    style={{ fontSize: 34, fontWeight: 800, color: win ? GOLD : ACCENT, fontVariantNumeric: "tabular-nums" }}
                  >
                    {pl.total.toLocaleString()}
                  </div>
                  <div style={{ fontSize: 15, color: GOLD }}>{stars(pl.grade.stars)}</div>
                  <div style={{ fontSize: 12, color: "rgba(255,255,255,0.4)" }}>
                    {pl.roundsSung} {pl.roundsSung === 1 ? "song" : "songs"} · avg{" "}
                    {pl.avg.toLocaleString()}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      ) : (
        <>
          <div
            style={{ fontSize: 84, fontWeight: 800, color: ACCENT, fontVariantNumeric: "tabular-nums", lineHeight: 1 }}
          >
            {headline.total.toLocaleString()}
          </div>
          <div style={{ fontSize: 26, color: GOLD, fontWeight: 800 }}>
            {stars(headline.grade.stars)} {headline.grade.name}
          </div>
        </>
      )}

      <table
        style={{
          marginTop: 18,
          borderCollapse: "collapse",
          background: "rgba(255,255,255,0.03)",
          borderRadius: 12,
          overflow: "hidden",
        }}
      >
        <thead>
          <tr>
            <th style={head}>#</th>
            <th style={{ ...head, textAlign: "left" }}>Song</th>
            {multiplayer && <th style={{ ...head, textAlign: "left" }}>Singer</th>}
            <th style={head}>Grade</th>
            <th style={{ ...head, textAlign: "right" }}>Score</th>
          </tr>
        </thead>
        <tbody>
          {summary.rounds.map((r, i) => {
            const sc = r.scores[0];
            const best = summary.bestRound?.title === r.title;
            return (
              <tr key={i} style={{ background: best ? `${GOLD}18` : "transparent" }}>
                <td style={{ ...cell, color: "rgba(255,255,255,0.5)" }}>{i + 1}</td>
                <td style={{ ...cell, textAlign: "left", fontWeight: 700 }}>
                  {r.title} {best && <span style={{ color: GOLD }}>★ best</span>}
                </td>
                {multiplayer && (
                  <td style={{ ...cell, textAlign: "left", color: ACCENT, fontWeight: 700 }}>
                    {sc.player}
                  </td>
                )}
                <td style={{ ...cell, color: GOLD }}>{stars(sc.grade.stars)}</td>
                <td style={{ ...cell, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                  {sc.total.toLocaleString()}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div style={{ display: "flex", gap: 12, marginTop: 20 }}>
        {onSave && (
          <button style={ghostBtn(React)} onClick={onSave}>
            💾 Save as playlist
          </button>
        )}
        <button style={primaryBtn(React)} onClick={onDone}>
          Done
        </button>
      </div>
    </Center>
  );
}

// ── shared bits ──────────────────────────────────────────────────────────────

function Center(props: { children: unknown }) {
  const React = Spicetify.React;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 10,
        height: "100vh",
        color: "#fff",
        textAlign: "center",
        fontFamily: "var(--font-family, 'Spotify Circular', system-ui, sans-serif)",
      }}
    >
      {props.children as never}
    </div>
  );
}

function primaryBtn(_react: unknown): Record<string, string | number> {
  return {
    padding: "12px 22px",
    borderRadius: 12,
    fontSize: 18,
    fontWeight: 800,
    cursor: "pointer",
    border: "none",
    background: ACCENT,
    color: "#04160b",
  };
}
function ghostBtn(_react: unknown): Record<string, string | number> {
  return {
    padding: "12px 22px",
    borderRadius: 12,
    fontSize: 18,
    fontWeight: 700,
    cursor: "pointer",
    border: "1px solid rgba(255,255,255,0.16)",
    background: "transparent",
    color: "#fff",
  };
}
