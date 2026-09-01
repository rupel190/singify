/**
 * stats-view.tsx — the "📊 Stats" screen (opened from the K menu).
 *
 * Reads the round history and shows the derived cuts: which MIC performs best
 * (the headline — sorted best average first), which SINGER performs best, and a
 * recent-rounds strip. Pure view: the adapter hands it the rounds + onBack.
 */

import type { StatRound } from "./stats";
import { aggregateByMic, aggregateByPlayer } from "./stats";
import { ACCENT, GOLD, SURFACE } from "./theme";

const C = {
  ...SURFACE,
  row: "#1b1b22",
  green: ACCENT,
  gold: GOLD,
};

function fmt(n: number): string {
  return Math.round(n).toLocaleString();
}

export function StatsScreen(props: {
  rounds: StatRound[];
  helperDown?: boolean;
  onBack: () => void;
}) {
  const React = Spicetify.React;
  const { rounds, helperDown, onBack } = props;
  const mics = aggregateByMic(rounds);
  const players = aggregateByPlayer(rounds);
  const recent = [...rounds].sort((a, b) => b.t - a.t).slice(0, 8);

  const backBtn: React.CSSProperties = {
    background: "transparent",
    color: C.sub,
    border: `1px solid ${C.border}`,
    borderRadius: 20,
    padding: "8px 18px",
    font: "600 14px system-ui",
    cursor: "pointer",
  };

  return (
    <div
      style={{
        // Scale up like the other menu screens; multiplies with the root UI_SCALE.
        zoom: 1.4,
        height: "100%",
        overflowY: "auto",
        padding: "28px 32px 48px",
        boxSizing: "border-box",
        color: C.text,
        fontFamily: "var(--font-family, 'Spotify Circular', system-ui, sans-serif)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          maxWidth: 820,
          margin: "0 auto 20px",
        }}
      >
        <div>
          <div style={{ fontSize: 30, fontWeight: 800 }}>📊 Stats</div>
          <div style={{ fontSize: 15, color: C.sub, marginTop: 2 }}>
            {rounds.length} {rounds.length === 1 ? "round" : "rounds"} recorded
          </div>
        </div>
        <button onClick={onBack} style={backBtn}>
          ← Back
        </button>
      </div>

      {helperDown && (
        <div
          style={{
            maxWidth: 820,
            margin: "0 auto 16px",
            padding: "14px 18px",
            display: "flex",
            gap: 10,
            alignItems: "baseline",
            fontSize: 15,
            lineHeight: 1.5,
            background: "rgba(230,180,34,0.10)",
            border: "1px solid rgba(230,180,34,0.35)",
            borderRadius: 12,
          }}
        >
          <span style={{ fontSize: 18 }}>⚠️</span>
          <span style={{ color: C.text }}>
            Karaoke helper isn't running — any saved history is on disk but can't be
            read right now. Start it with{" "}
            <code style={{ color: C.gold, fontFamily: "ui-monospace, monospace" }}>
              bun run helper
            </code>
            , then reopen.
          </span>
        </div>
      )}

      {rounds.length === 0 ? (
        helperDown ? null : (
          <div
            style={{
              maxWidth: 820,
              margin: "0 auto",
              padding: "40px 24px",
              textAlign: "center",
              color: C.sub,
              fontSize: 16,
              background: C.card,
              border: `1px solid ${C.border}`,
              borderRadius: 14,
              lineHeight: 1.5,
            }}
          >
            No rounds yet. Play a session — each scored song is saved here with the
            mic and settings it was sung on, so you can see which setup wins.
          </div>
        )
      ) : (
        <div style={{ maxWidth: 820, margin: "0 auto", display: "flex", flexDirection: "column", gap: 22 }}>
          <Section title="By microphone" hint="best average first">
            <Table
              head={["Mic", "Rounds", "Avg", "Best"]}
              rows={mics.map((m, i) => ({
                lead: i === 0,
                cells: [
                  m.device,
                  String(m.rounds),
                  fmt(m.avg),
                  <span key="b">
                    {fmt(m.best)}
                    {m.bestSong && (
                      <span style={{ color: C.sub, fontWeight: 400 }}> · {m.bestSong}</span>
                    )}
                  </span>,
                ],
              }))}
            />
          </Section>

          <Section title="By singer">
            <Table
              head={["Singer", "Rounds", "Avg", "Best"]}
              rows={players.map((p, i) => ({
                lead: i === 0,
                cells: [p.name, String(p.rounds), fmt(p.avg), fmt(p.best)],
              }))}
            />
          </Section>

          <Section title="Recent">
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {recent.map((r, i) => {
                const ranked = [...r.players].sort((a, b) => b.score - a.score);
                const song = [r.artist, r.title].filter(Boolean).join(" — ") || "(unknown)";
                return (
                  <div
                    key={i}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 12,
                      padding: "10px 14px",
                      background: C.row,
                      border: `1px solid ${C.border}`,
                      borderRadius: 10,
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div
                        style={{
                          fontWeight: 600,
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {song}
                      </div>
                      <div style={{ fontSize: 13, color: C.sub, textTransform: "capitalize" }}>
                        {r.difficulty}
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 8, flexShrink: 0, flexWrap: "wrap", justifyContent: "flex-end" }}>
                      {ranked.map((p, j) => (
                        <span
                          key={j}
                          style={{
                            fontSize: 13,
                            fontWeight: 600,
                            padding: "3px 9px",
                            borderRadius: 999,
                            color: j === 0 && ranked.length > 1 ? "#08210f" : C.text,
                            background: j === 0 && ranked.length > 1 ? C.green : C.card,
                            border: `1px solid ${C.border}`,
                          }}
                        >
                          {p.name} {fmt(p.score)}
                        </span>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </Section>
        </div>
      )}
    </div>
  );
}

function Section(props: { title: string; hint?: string; children: unknown }) {
  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: 1.2, color: C.sub, textTransform: "uppercase" }}>
          {props.title}
        </div>
        {props.hint && <div style={{ fontSize: 12, color: C.sub }}>{props.hint}</div>}
      </div>
      {props.children as never}
    </div>
  );
}

function Table(props: {
  head: string[];
  rows: { lead?: boolean; cells: unknown[] }[];
}) {
  const { head, rows } = props;
  return (
    <div style={{ overflowX: "auto", background: C.card, border: `1px solid ${C.border}`, borderRadius: 12 }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 15 }}>
        <thead>
          <tr>
            {head.map((h, i) => (
              <th
                key={i}
                style={{
                  textAlign: i === 0 ? "left" : "right",
                  fontSize: 12,
                  fontWeight: 700,
                  letterSpacing: 0.5,
                  color: C.sub,
                  textTransform: "uppercase",
                  padding: "6px 12px",
                }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri} style={{ borderTop: `1px solid ${C.border}` }}>
              {r.cells.map((c, ci) => (
                <td
                  key={ci}
                  style={{
                    padding: "10px 12px",
                    textAlign: ci === 0 ? "left" : "right",
                    fontWeight: ci === 0 ? 600 : 500,
                    color: r.lead && ci === 2 ? C.green : C.text,
                    whiteSpace: ci === 0 ? "normal" : "nowrap",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {r.lead && ci === 0 ? <span>👑 {c as never}</span> : (c as never)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
