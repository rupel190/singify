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

import type { RoundResult, SessionSummary } from "./session";

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
  rounds: number;
  onRounds: (n: number) => void;
  onStart: () => void;
  onCancel: () => void;
  micOn: boolean;
}) {
  const React = Spicetify.React;
  const { rounds, onRounds, onStart, onCancel, micOn } = props;
  const chip = (n: number): React.CSSProperties => ({
    padding: "10px 20px",
    borderRadius: 12,
    fontSize: 22,
    fontWeight: 800,
    cursor: "pointer",
    border: `1px solid ${rounds === n ? ACCENT : "rgba(255,255,255,0.12)"}`,
    background: rounds === n ? `${ACCENT}22` : "rgba(255,255,255,0.04)",
    color: rounds === n ? ACCENT : "#fff",
  });

  return (
    <Center>
      <div style={{ fontSize: 34, fontWeight: 800 }}>New Session</div>
      <div style={{ color: "rgba(255,255,255,0.6)", fontSize: 17 }}>
        How many rounds? Sing that many songs — scores add up to a big finish.
      </div>
      <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
        {[3, 5, 10].map((n) => (
          <button key={n} style={chip(n)} onClick={() => onRounds(n)}>
            {n}
          </button>
        ))}
      </div>
      <div
        style={{
          marginTop: 12,
          fontSize: 15,
          color: micOn ? ACCENT : "#ff9e6b",
          fontWeight: 600,
        }}
      >
        {micOn ? "🎤 Mic on — you'll be scored" : "🎤 Mic is off — Start will turn it on"}
      </div>
      <div style={{ display: "flex", gap: 12, marginTop: 18 }}>
        <button style={primaryBtn(React)} onClick={onStart}>
          ▶ Start {rounds} rounds
        </button>
        <button style={ghostBtn(React)} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </Center>
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
}) {
  const React = Spicetify.React;
  const { round, target, sessionTotal, mics, onSkip, onEnd } = props;
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
      <div style={{ fontSize: 18, fontWeight: 800 }}>
        Round <span style={{ color: ACCENT }}>{round}</span>/{target}
      </div>
      <div style={{ fontSize: 18, fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>
        {sessionTotal.toLocaleString()}
      </div>
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

// ── Between rounds ───────────────────────────────────────────────────────────

export function RoundEnd(props: {
  justFinished: RoundResult;
  roundNumber: number;
  target: number;
  sessionTotal: number;
  onContinue: () => void;
}) {
  const React = Spicetify.React;
  const { justFinished, roundNumber, target, sessionTotal, onContinue } = props;
  const s = justFinished.scores[0];
  const last = roundNumber >= target;
  return (
    <Center>
      <div style={{ fontSize: 22, color: "rgba(255,255,255,0.6)", fontWeight: 700 }}>
        Round {roundNumber} of {target} done
      </div>
      <div style={{ fontSize: 30, fontWeight: 800 }}>{justFinished.title}</div>
      <div style={{ fontSize: 22, color: GOLD }}>{stars(s.grade.stars)}</div>
      <div
        style={{ fontSize: 56, fontWeight: 800, color: ACCENT, fontVariantNumeric: "tabular-nums" }}
      >
        {s.total.toLocaleString()}
      </div>
      <div style={{ fontSize: 16, color: "rgba(255,255,255,0.6)" }}>
        Session total {sessionTotal.toLocaleString()}
      </div>
      <button style={{ ...primaryBtn(React), marginTop: 16 }} onClick={onContinue}>
        {last ? "See the results ▶" : "Next — play another song ▶"}
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
  const p = summary.players[0]; // headline player (multi-player renders columns later)

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
      <div
        style={{ fontSize: 84, fontWeight: 800, color: ACCENT, fontVariantNumeric: "tabular-nums", lineHeight: 1 }}
      >
        {p.total.toLocaleString()}
      </div>
      <div style={{ fontSize: 26, color: GOLD, fontWeight: 800 }}>
        {stars(p.grade.stars)} {p.grade.name}
      </div>

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
