/**
 * session-view.tsx — the session screens (pure views; the adapter drives state).
 *
 *   SessionSetup        — choose round count + confirm mic, then Start
 *   MicStrip / MicOverlay — live mic level meters (in-session HUD + solo)
 *   SessionHud          — compact overlay during a round (progress, total, mics)
 *   RoundEnd            — between rounds: the round you just finished + what's next
 *   SessionResultScreen — the big aggregate finish (per-round leaderboard + total)
 *
 * All multiplayer-shaped: mics and per-round scores are lists (length 1 today).
 */

import type { RoundResult, SessionSummary, SessionTrack } from "./session";
import type { PlaylistRef } from "./playlist-source";
import type { AudioInput, AudioOutput } from "./mic";
import type { Difficulty } from "./scoring";
import { PLAYER_COLORS } from "./karaoke-view";
import { MicMeter } from "./mic-meter";
import { ACCENT, GOLD } from "./theme";

/**
 * One live mic as the in-game banner sees it: the player's whole roster slot
 * (name, device, gain, gate) plus a live level getter. Same shape the setup
 * screen edits, so both surfaces drive the identical set of controls.
 */
export interface HudMic extends PlayerSlot {
  getLevel: () => number; // current post-gain RMS (0..~0.4)
}

/**
 * One player's setup slot: display name + which input device feeds them + a
 * per-mic input gain. In versus every slot sings at once on its own device;
 * solo is a single slot. deviceId undefined = the system default input.
 */
export interface PlayerSlot {
  name: string;
  deviceId?: string;
  gain: number; // input-gain multiplier (1 = unity)
  sensitivity: number; // 0..100 → this player's OWN detection gate
  monitor?: boolean; // hear this mic out an output device while singing
  monitorGain?: number; // monitor loudness 0..1 (independent of `gain`)
  outputDeviceId?: string; // which output the monitor plays to (undefined = default)
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
  /** Scoring difficulty — pitch tolerance for scoring + the visual hit-snap. */
  difficulty: Difficulty;
  onDifficulty: (d: Difficulty) => void;
  onStart: () => void;
  onCancel: () => void;
  micOn: boolean;
  // Versus roster — every player sings at once on their OWN mic.
  players: PlayerSlot[];
  onName: (i: number, name: string) => void;
  onDevice: (i: number, deviceId: string | undefined) => void;
  onGain: (i: number, gain: number) => void;
  onAddPlayer: () => void;
  onRemovePlayer: (i: number) => void;
  /** Available audio input devices for the per-player mic picker. */
  devices: AudioInput[];
  /** Live input level (0..~0.4) for player i's preview mic — drives the meter. */
  levelFor: (i: number) => number;
  /** Each player drags their OWN gate; the index says whose. */
  onSensitivity: (i: number, n: number) => void;
}) {
  const React = Spicetify.React;
  const {
    playlists,
    loadingPlaylists,
    onStartPlaylist,
    current,
    rounds,
    onRounds,
    difficulty,
    onDifficulty,
    onStart,
    onCancel,
    micOn,
    players,
    onName,
    onDevice,
    onGain,
    onAddPlayer,
    onRemovePlayer,
    devices,
    levelFor,
    onSensitivity,
  } = props;

  const MAX_PLAYERS = 4; // versus: one lane + colour + mic per singer

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
    <Center zoom={1.5}>
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
        {/* Roster — one slot is solo; add singers for VERSUS (all sing at once,
            each on their OWN mic). Every slot picks its input device + gain. */}
        <div style={sectionLabel}>
          Players{" "}
          {players.length > 1 && (
            <span style={{ color: ACCENT }}>· versus — everyone sings at once</span>
          )}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {players.map((p, i) => (
            <div
              key={i}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 8,
                padding: "10px 12px",
                borderRadius: 10,
                background: "rgba(255,255,255,0.05)",
                border: "1px solid rgba(255,255,255,0.1)",
              }}
            >
              {/* line 1: colour dot · name · device · remove */}
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span
                  style={{
                    color: PLAYER_COLORS[i % PLAYER_COLORS.length],
                    fontWeight: 800,
                    fontSize: 16,
                  }}
                >
                  ●
                </span>
                <input
                  value={p.name}
                  onChange={(e) => onName(i, (e.target as HTMLInputElement).value)}
                  maxLength={16}
                  style={{
                    width: 96,
                    background: "transparent",
                    border: "none",
                    borderBottom: "1px solid rgba(255,255,255,0.15)",
                    color: "#fff",
                    fontSize: 15,
                    fontWeight: 600,
                    outline: "none",
                  }}
                />
                <select
                  value={p.deviceId ?? ""}
                  onChange={(e) =>
                    onDevice(i, (e.target as HTMLSelectElement).value || undefined)
                  }
                  style={{
                    flex: "1 1 auto",
                    minWidth: 0,
                    background: "rgba(0,0,0,0.3)",
                    border: "1px solid rgba(255,255,255,0.12)",
                    borderRadius: 8,
                    color: "#fff",
                    fontSize: 13,
                    padding: "5px 8px",
                  }}
                >
                  <option value="">Default mic</option>
                  {devices.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label}
                    </option>
                  ))}
                </select>
                {players.length > 1 && (
                  <button
                    onClick={() => onRemovePlayer(i)}
                    title="Remove"
                    style={{
                      border: "none",
                      background: "transparent",
                      color: "rgba(255,255,255,0.5)",
                      cursor: "pointer",
                      fontSize: 18,
                      lineHeight: 1,
                      padding: "0 2px",
                      flexShrink: 0,
                    }}
                  >
                    ×
                  </button>
                )}
              </div>

              {/* line 2: live level meter (drag the gate) · input gain */}
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{ flex: "1 1 auto", minWidth: 0 }}>
                  <MicMeter
                    getLevel={() => levelFor(i)}
                    sensitivity={p.sensitivity}
                    onSensitivity={(n) => onSensitivity(i, n)}
                    color={PLAYER_COLORS[i % PLAYER_COLORS.length]}
                    height={14}
                  />
                </div>
                <div
                  style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}
                  title="Input gain — where this mic's level sits on the meter"
                >
                  <span style={{ fontSize: 12, color: "rgba(255,255,255,0.4)" }}>gain</span>
                  <input
                    type="range"
                    min={25}
                    max={300}
                    value={Math.round(p.gain * 100)}
                    onChange={(e) => onGain(i, Number((e.target as HTMLInputElement).value) / 100)}
                    style={{ width: 84 }}
                  />
                  <span
                    style={{
                      fontSize: 12,
                      color: "rgba(255,255,255,0.55)",
                      width: 36,
                      textAlign: "right",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {Math.round(p.gain * 100)}%
                  </span>
                </div>
              </div>
            </div>
          ))}
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {players.length < MAX_PLAYERS && (
              <button
                onClick={onAddPlayer}
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
            {devices.length === 0 && (
              <span style={{ fontSize: 12, color: "rgba(255,255,255,0.4)" }}>
                Grant mic access to see device names.
              </span>
            )}
          </div>
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

        <div style={{ ...sectionLabel, marginTop: 8 }}>Difficulty</div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {(["easy", "medium", "hard"] as Difficulty[]).map((d) => {
            const on = difficulty === d;
            return (
              <button
                key={d}
                onClick={() => onDifficulty(d)}
                title={
                  d === "easy"
                    ? "±2 semitones — forgiving"
                    : d === "medium"
                      ? "±1 semitone"
                      : "±0 — exact pitch (rap/spoken notes are never pitch-scored)"
                }
                style={{
                  padding: "8px 16px",
                  borderRadius: 12,
                  fontSize: 20,
                  fontWeight: 800,
                  textTransform: "capitalize",
                  cursor: "pointer",
                  border: `1px solid ${on ? ACCENT : "rgba(255,255,255,0.12)"}`,
                  background: on ? `${ACCENT}22` : "rgba(255,255,255,0.04)",
                  color: on ? ACCENT : "#fff",
                }}
              >
                {d}
              </button>
            );
          })}
        </div>

        <div style={{ ...sectionLabel, marginTop: 8 }}>Or free play</div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {[3, 5, 10].map((n) => (
            <button key={n} style={chip(n)} onClick={() => onRounds(n)}>
              {n}
            </button>
          ))}
          <button style={{ ...primaryBtn(), marginLeft: "auto" }} onClick={onStart}>
            ▶ {rounds} rounds
          </button>
        </div>
      </div>

      <button style={{ ...ghostBtn(), marginTop: 16 }} onClick={onCancel}>
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

// ── Mic meters (shared by the session HUD and solo Quick Sing) ───────────────

/** Banner geometry: one player strip's target width and its caption size. */
const BAR_W = 600;
const BAR_LABEL = 48;

/**
 * The in-game mic banner — one strip per live singer, in the RIGHT-hand cell of
 * the stage's top row: level meter with that player's OWN gate handle, an input-gain
 * slider, and a device picker. Every control is live; gain and gate apply to the
 * running mic instantly, and changing the device restarts only that one mic.
 *
 * Gate and gain overlap on purpose (a gate is reachable by moving either), and
 * both are here because they answer different questions in a noisy room: gain
 * puts your voice in the readable middle of the bar, the gate says where the
 * line sits once it's there.
 */
export function MicOverlay(props: {
  mics: HudMic[];
  devices: AudioInput[];
  /** Output devices for the monitor picker; empty hides it (or routing unsupported). */
  outputs: AudioOutput[];
  /** False when the engine can't route to a chosen output — monitor still works on default. */
  routingSupported: boolean;
  onGain: (i: number, gain: number) => void;
  onSensitivity: (i: number, sensitivity: number) => void;
  onDevice: (i: number, deviceId: string | undefined) => void;
  onMonitor: (i: number, on: boolean) => void;
  onMonitorGain: (i: number, gain: number) => void;
  onOutput: (i: number, deviceId: string | undefined) => void;
}) {
  const React = Spicetify.React;
  const {
    mics,
    devices,
    outputs,
    routingSupported,
    onGain,
    onSensitivity,
    onDevice,
    onMonitor,
    onMonitorGain,
    onOutput,
  } = props;
  const selectStyle: React.CSSProperties = {
    width: "100%",
    minWidth: 0,
    background: "rgba(0,0,0,0.35)",
    border: "1px solid rgba(255,255,255,0.12)",
    borderRadius: 8,
    color: "#fff",
    fontSize: 18,
    padding: "6px 9px",
  };
  // Width comes from the roster, never from the content: with equal flex
  // columns inside, a content-sized pill would collapse onto the labels.
  const n = Math.max(1, mics.length);
  const wanted = n * BAR_W + (n - 1) * BAR_LABEL + 56;
  const readout: React.CSSProperties = {
    fontSize: 18,
    fontWeight: 700,
    color: "rgba(255,255,255,0.45)",
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap", // gate/gain stay on one line, so columns don't misalign
  };
  return (
    <div
      style={{
        justifySelf: "end",
        width: `min(100%, ${wanted}px)`,
        padding: "12px 20px",
        borderRadius: 16,
        background: "rgba(8,8,12,0.72)",
        border: "1px solid rgba(255,255,255,0.1)",
        color: "#fff",
        fontFamily: "var(--font-family, 'Spotify Circular', system-ui, sans-serif)",
      }}
    >
      <div style={{ display: "flex", gap: BAR_LABEL, alignItems: "flex-start", width: "100%" }}>
        {mics.map((m, i) => {
          const tint = PLAYER_COLORS[i % PLAYER_COLORS.length];
          return (
            // `flex: 1 1 0` = equal columns sized by the banner, not by their
            // own contents, so a long device name can't shove the other singer.
            <div
              key={i}
              style={{ flex: "1 1 0", minWidth: 0, display: "flex", flexDirection: "column", gap: 7 }}
            >
              <MicMeter
                getLevel={m.getLevel}
                sensitivity={m.sensitivity}
                onSensitivity={(n2) => onSensitivity(i, n2)}
                label={mics.length > 1 ? m.name : "🎤"}
                labelColor={tint}
                color={tint}
                height={44}
                labelSize={32}
              />
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span style={readout}>gate {Math.round(m.sensitivity)}%</span>
                <span style={{ ...readout, marginLeft: "auto" }}>
                  gain {Math.round(m.gain * 100)}%
                </span>
              </div>
              <input
                type="range"
                min={25}
                max={300}
                value={Math.round(m.gain * 100)}
                onChange={(e) => onGain(i, Number((e.target as HTMLInputElement).value) / 100)}
                title="Input gain"
                style={{ width: "100%" }}
              />
              <select
                value={m.deviceId ?? ""}
                onChange={(e) => onDevice(i, (e.target as HTMLSelectElement).value || undefined)}
                title="Input device — switching restarts this mic only"
                style={selectStyle}
              >
                <option value="">Default mic</option>
                {devices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label}
                  </option>
                ))}
              </select>

              {/* ── Monitor: hear this mic out an output while singing ── */}
              {(() => {
                const on = !!m.monitor;
                const vol = Math.round((m.monitorGain ?? 0.05) * 100);
                return (
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      <button
                        onClick={() => onMonitor(i, !on)}
                        title="Play this mic back out an output device (use headphones to avoid feedback)"
                        style={{
                          fontSize: 18,
                          fontWeight: 700,
                          padding: "6px 10px",
                          borderRadius: 8,
                          cursor: "pointer",
                          border: `1px solid ${on ? tint : "rgba(255,255,255,0.14)"}`,
                          background: on ? `${tint}22` : "rgba(0,0,0,0.35)",
                          color: on ? tint : "#fff",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {on ? "🔊 Monitor" : "🔇 Monitor"}
                      </button>
                      <span style={{ ...readout, marginLeft: "auto" }}>{vol}%</span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={vol}
                      disabled={!on}
                      onChange={(e) =>
                        onMonitorGain(i, Number((e.target as HTMLInputElement).value) / 100)
                      }
                      title="Monitor volume"
                      style={{ width: "100%", opacity: on ? 1 : 0.4 }}
                    />
                    {routingSupported && (
                      <select
                        value={m.outputDeviceId ?? ""}
                        disabled={!on}
                        onChange={(e) =>
                          onOutput(i, (e.target as HTMLSelectElement).value || undefined)
                        }
                        title="Monitor output device"
                        style={{ ...selectStyle, opacity: on ? 1 : 0.4 }}
                      >
                        <option value="">Default output</option>
                        {outputs.map((d) => (
                          <option key={d.deviceId} value={d.deviceId}>
                            {d.label}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                );
              })()}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The middle cell of the top row: what you're singing right now. Title over
 * artist, both clipped to one line so a long name can't widen the box and shove
 * the row's centre off — the row is a 1fr/auto/1fr grid, so this stays dead
 * centre on screen however wide the HUD or the mic banner get.
 */
export function NowPlaying(props: { title: string; artist: string }) {
  const React = Spicetify.React;
  const clip: React.CSSProperties = {
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  };
  return (
    <div
      style={{
        maxWidth: "100%",
        minWidth: 0,
        padding: "18px 34px",
        borderRadius: 22,
        background: "rgba(8,8,12,0.72)",
        border: "1px solid rgba(255,255,255,0.1)",
        color: "#fff",
        textAlign: "center",
        fontFamily: "var(--font-family, 'Spotify Circular', system-ui, sans-serif)",
      }}
    >
      <div style={{ ...clip, fontSize: 64, fontWeight: 800, lineHeight: 1.05 }}>
        {props.title}
      </div>
      <div style={{ ...clip, fontSize: 40, fontWeight: 600, color: "rgba(255,255,255,0.55)" }}>
        {props.artist}
      </div>
    </div>
  );
}

// ── Competitive lobby ────────────────────────────────────────────────────────

/**
 * CompetitiveSetup — the ⚔ Competitive lobby. One mic, one song; each named
 * singer takes the same track solo in turn, then scores go head-to-head. The
 * adapter snapshots whatever's playing as the duel song.
 */
export function CompetitiveSetup(props: {
  players: string[];
  difficulty: Difficulty;
  devices: AudioInput[];
  deviceId?: string;
  track: { title: string; artist: string } | null;
  onName: (i: number, name: string) => void;
  onAdd: () => void;
  onRemove: (i: number) => void;
  onDifficulty: (d: Difficulty) => void;
  onDevice: (id: string | undefined) => void;
  onStart: () => void;
  onCancel: () => void;
}) {
  const React = Spicetify.React;
  const {
    players, difficulty, devices, deviceId, track,
    onName, onAdd, onRemove, onDifficulty, onDevice, onStart, onCancel,
  } = props;
  const field: React.CSSProperties = {
    background: "rgba(0,0,0,0.35)",
    border: "1px solid rgba(255,255,255,0.14)",
    borderRadius: 10,
    color: "#fff",
    fontSize: 20,
    padding: "8px 12px",
  };
  const chip = (on: boolean): React.CSSProperties => ({
    ...field,
    cursor: "pointer",
    textTransform: "capitalize",
    fontWeight: 700,
    color: on ? "#08210f" : "#fff",
    background: on ? ACCENT : "rgba(0,0,0,0.35)",
    borderColor: on ? ACCENT : "rgba(255,255,255,0.14)",
  });
  return (
    <Center zoom={1.4} gap={18}>
      <div style={{ fontSize: 40, fontWeight: 900 }}>⚔ Competitive</div>
      <div style={{ fontSize: 17, color: "rgba(255,255,255,0.6)", textAlign: "center", maxWidth: 520 }}>
        One mic, one song — each singer takes the same track solo, then scores go head-to-head. Pure skill.
      </div>
      <div style={{ ...field, width: 460, textAlign: "center", fontWeight: 600, color: track ? "#fff" : GOLD }}>
        {track ? `${track.title} — ${track.artist}` : "▶ Play a song first, then start the duel"}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, width: 460 }}>
        {players.map((name, i) => (
          <div key={i} style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span style={{ color: PLAYER_COLORS[i % PLAYER_COLORS.length], fontWeight: 800, width: 22 }}>
              {i + 1}
            </span>
            <input
              value={name}
              placeholder={`P${i + 1}`}
              onChange={(e) => onName(i, (e.target as HTMLInputElement).value)}
              style={{ ...field, flex: 1, minWidth: 0 }}
            />
            {players.length > 2 && (
              <button onClick={() => onRemove(i)} title="Remove" style={{ ...ghostBtn(), padding: "6px 12px" }}>
                ✕
              </button>
            )}
          </div>
        ))}
        {players.length < 4 && (
          <button onClick={onAdd} style={{ ...ghostBtn(), alignSelf: "flex-start" }}>
            + Add singer
          </button>
        )}
      </div>
      <select
        value={deviceId ?? ""}
        onChange={(e) => onDevice((e.target as HTMLSelectElement).value || undefined)}
        title="Shared mic — everyone sings on this one"
        style={{ ...field, width: 460 }}
      >
        <option value="">Default mic</option>
        {devices.map((d) => (
          <option key={d.deviceId} value={d.deviceId}>
            {d.label}
          </option>
        ))}
      </select>
      <div style={{ display: "flex", gap: 8 }}>
        {(["easy", "medium", "hard"] as const).map((d) => (
          <button key={d} onClick={() => onDifficulty(d)} style={chip(difficulty === d)}>
            {d}
          </button>
        ))}
      </div>
      <div style={{ display: "flex", gap: 12, marginTop: 4 }}>
        <button
          onClick={onStart}
          disabled={!track}
          style={{ ...primaryBtn(), opacity: track ? 1 : 0.45, cursor: track ? "pointer" : "default" }}
        >
          ⚔ Start duel
        </button>
        <button onClick={onCancel} style={ghostBtn()}>
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
  /** Running total per player across COMPLETED rounds, in roster order. */
  totals: { name: string; total: number }[];
  /** Whether any mic is live; the controls themselves are in MicOverlay. */
  micsOn: boolean;
  onSkip: () => void;
  onEnd: () => void;
  /** Drop every player's running score and start the song's scoring over. */
  onResetScores: () => void;
  /** Seek back to 0 and score from the top. */
  onRestartSong: () => void;
  /** Hop past tracks with no chart instead of parking on the no-chart card. */
  autoSkip: boolean;
  onAutoSkip: (on: boolean) => void;
  /** Source playlist name, shown when the session is playlist-sourced. */
  sourceName?: string | null;
}) {
  const React = Spicetify.React;
  const {
    round,
    target,
    totals,
    micsOn,
    onSkip,
    onEnd,
    onResetScores,
    onRestartSong,
    autoSkip,
    onAutoSkip,
    sourceName,
  } = props;
  // 3+ players add a total line per singer AND wrap the button row, so the box
  // grows down into the note lane. Shrink the whole HUD once it's that crowded —
  // it never needed the full 2-player size, and this keeps it above the lane.
  const k = totals.length > 2 ? 0.62 : 1;
  const px = (n: number) => Math.round(n * k);
  const btn: React.CSSProperties = {
    padding: `${px(16)}px ${px(40)}px`,
    borderRadius: px(26),
    fontSize: px(52),
    fontWeight: 700,
    cursor: "pointer",
    border: "1px solid rgba(255,255,255,0.14)",
    background: "rgba(0,0,0,0.4)",
    color: "#fff",
  };
  // 4× type in the old single row would have stretched across the whole stage
  // and collided with the centred mic banner, so the HUD stacks instead.
  return (
    <div
      style={{
        justifySelf: "start",
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        gap: px(18),
        padding: `${px(24)}px ${px(34)}px`,
        borderRadius: px(34),
        background: "rgba(8,8,12,0.72)",
        border: "1px solid rgba(255,255,255,0.1)",
        color: "#fff",
        fontFamily: "var(--font-family, 'Spotify Circular', system-ui, sans-serif)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: px(28) }}>
        <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.1 }}>
          {sourceName && (
            <span
              style={{
                fontSize: px(40),
                fontWeight: 700,
                letterSpacing: 0.5,
                color: "rgba(255,255,255,0.5)",
                maxWidth: 620,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {sourceName}
            </span>
          )}
          <span style={{ fontSize: px(72), fontWeight: 800 }}>
            Round <span style={{ color: ACCENT }}>{round}</span>/{target}
          </span>
        </div>
        {/* Banked total per singer — the in-progress song is NOT in here; that
            number lives at the bottom of the lane and only lands when the song
            ends. Labelled, because an unlabelled figure beside a round counter
            reads as a mystery. */}
        <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.05 }}>
          <span
            style={{
              fontSize: px(40),
              fontWeight: 700,
              letterSpacing: 0.5,
              color: "rgba(255,255,255,0.5)",
            }}
          >
            total
          </span>
          {totals.map((t, i) => {
            const tint = PLAYER_COLORS[i % PLAYER_COLORS.length];
            return (
              <div key={i} style={{ display: "flex", alignItems: "baseline", gap: px(14) }}>
                {totals.length > 1 && (
                  <span style={{ fontSize: px(40), fontWeight: 800, color: tint }}>{t.name}</span>
                )}
                <span
                  style={{
                    fontSize: px(72),
                    fontWeight: 800,
                    fontVariantNumeric: "tabular-nums",
                    color: totals.length > 1 ? tint : "#fff",
                  }}
                >
                  {t.total.toLocaleString()}
                </span>
              </div>
            );
          })}
        </div>
        {/* The meters themselves are the centred MicOverlay banner; the HUD only
            says whether anything is live at all. */}
        {!micsOn && (
          <span style={{ fontSize: px(52), fontWeight: 700, color: "rgba(255,255,255,0.4)" }}>
            🎤 off
          </span>
        )}
      </div>
      {/* Wraps, because five buttons at this type size outrun the HUD's column
          on a narrower screen. */}
      <div style={{ display: "flex", gap: px(18), flexWrap: "wrap" }}>
        <button style={btn} onClick={onSkip}>
          Skip
        </button>
        <button style={btn} onClick={onEnd}>
          End
        </button>
        <button style={btn} onClick={onRestartSong} title="Play this song from the top">
          ⟲ Restart
        </button>
        <button
          style={btn}
          onClick={onResetScores}
          title="Clear every singer's score and keep playing"
        >
          ↺ Scores
        </button>
        <button
          style={{
            ...btn,
            borderColor: autoSkip ? ACCENT : "rgba(255,255,255,0.14)",
            background: autoSkip ? `${ACCENT}1f` : "rgba(0,0,0,0.4)",
            color: autoSkip ? ACCENT : "#fff",
          }}
          onClick={() => onAutoSkip(!autoSkip)}
          title="Skip tracks with no karaoke chart automatically, instead of stopping on them"
        >
          {autoSkip ? "☑" : "☐"} Auto-skip
        </button>
      </div>
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
  /** The helper is unreachable — the real reason there's "no chart". */
  helperDown?: boolean;
}) {
  const React = Spicetify.React;
  const { title, artist, onSkip, onReChoose, searched, helperDown } = props;
  // A down helper is the actual cause — say so instead of blaming the track.
  if (helperDown) {
    return <HelperDownNotice title={title} artist={artist} onSkip={onSkip} onReChoose={onReChoose} />;
  }
  return (
    <Center zoom={3}>
      <div style={{ fontSize: 40 }}>🎤</div>
      <div style={{ fontSize: 26, fontWeight: 800 }}>
        {searched ? "No karaoke chart for this track" : "Looking for a chart…"}
      </div>
      <div style={{ fontSize: 17, color: "rgba(255,255,255,0.6)" }}>
        {artist} — {title}
      </div>
      {searched && (
        <div style={{ display: "flex", gap: 12, marginTop: 18 }}>
          <button style={primaryBtn()} onClick={onSkip}>
            ⏭ Skip to next song
          </button>
          <button style={ghostBtn()} onClick={onReChoose}>
            🔎 Re-choose (R)
          </button>
        </div>
      )}
    </Center>
  );
}

// ── Helper-down caution ──────────────────────────────────────────────────────
//
// The overlay says "no karaoke chart" whenever a lookup comes back empty — but
// the most common first-run cause is that the localhost helper simply isn't
// running, and (surprising the first time) that also blanks *cached* songs,
// because the cache lives on disk behind the helper and the renderer has no
// filesystem of its own. So when a resolve fails because the helper is
// unreachable, show THIS instead of the generic "no chart" — a persistent,
// in-overlay caution that names the real reason, rather than a background toast
// that fires whether or not you're looking.
export function HelperDownNotice(props: {
  title?: string;
  artist?: string;
  onSkip?: () => void;
  onReChoose?: () => void;
}) {
  const React = Spicetify.React;
  const { title, artist, onSkip, onReChoose } = props;
  return (
    <Center zoom={2.4}>
      <div style={{ fontSize: 48 }}>⚠️</div>
      <div style={{ fontSize: 26, fontWeight: 800, color: GOLD }}>
        Karaoke helper isn't running
      </div>
      <div
        style={{
          fontSize: 17,
          color: "rgba(255,255,255,0.7)",
          maxWidth: 560,
          textAlign: "center",
          lineHeight: 1.45,
        }}
      >
        Charts load through the local helper — even songs you've already sung and
        cached. Start it in a terminal, then it'll pick this track up:
      </div>
      <code
        style={{
          marginTop: 4,
          padding: "8px 16px",
          borderRadius: 10,
          background: "rgba(255,255,255,0.06)",
          border: "1px solid rgba(255,255,255,0.12)",
          fontFamily: "ui-monospace, SFMono-Regular, monospace",
          fontSize: 18,
          color: "#fff",
        }}
      >
        bun run helper
      </code>
      {(title || artist) && (
        <div style={{ fontSize: 15, color: "rgba(255,255,255,0.5)", marginTop: 4 }}>
          {[artist, title].filter(Boolean).join(" — ")}
        </div>
      )}
      {(onSkip || onReChoose) && (
        <div style={{ display: "flex", gap: 12, marginTop: 18 }}>
          {onReChoose && (
            <button style={primaryBtn()} onClick={onReChoose}>
              ↻ Try again (R)
            </button>
          )}
          {onSkip && (
            <button style={ghostBtn()} onClick={onSkip}>
              ⏭ Skip to next song
            </button>
          )}
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
}) {
  const React = Spicetify.React;
  const { justFinished, roundNumber, target, sessionTotal, onContinue, upNext } = props;
  const scores = justFinished.scores;
  const versus = scores.length > 1;
  const ranked = [...scores].sort((a, b) => b.total - a.total);
  const solo = scores[0];
  const last = roundNumber >= target;
  return (
    <Center zoom={2}>
      <div style={{ fontSize: 22, color: "rgba(255,255,255,0.6)", fontWeight: 700 }}>
        Round {roundNumber} of {target} done
      </div>
      <div style={{ fontSize: 30, fontWeight: 800 }}>{justFinished.title}</div>

      {versus ? (
        /* Every singer's score for this round, round-winner first + crowned. */
        <div
          style={{
            display: "flex",
            gap: 12,
            flexWrap: "wrap",
            justifyContent: "center",
            marginTop: 4,
          }}
        >
          {ranked.map((s, i) => (
            <div
              key={s.player}
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 2,
                minWidth: 128,
                padding: "12px 16px",
                borderRadius: 12,
                border: `1px solid ${i === 0 ? GOLD : "rgba(255,255,255,0.1)"}`,
                background: i === 0 ? `${GOLD}14` : "rgba(255,255,255,0.03)",
              }}
            >
              <div style={{ fontSize: 15, fontWeight: 700, color: "rgba(255,255,255,0.7)" }}>
                {i === 0 ? "👑 " : ""}
                {s.player}
              </div>
              <div
                style={{
                  fontSize: 40,
                  fontWeight: 800,
                  color: i === 0 ? GOLD : ACCENT,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {s.total.toLocaleString()}
              </div>
              <div style={{ fontSize: 15, color: GOLD }}>{stars(s.grade.stars)}</div>
            </div>
          ))}
        </div>
      ) : (
        <>
          <div style={{ fontSize: 22, color: GOLD }}>{stars(solo.grade.stars)}</div>
          <div
            style={{ fontSize: 56, fontWeight: 800, color: ACCENT, fontVariantNumeric: "tabular-nums" }}
          >
            {solo.total.toLocaleString()}
          </div>
        </>
      )}

      <div style={{ fontSize: 16, color: "rgba(255,255,255,0.6)", marginTop: versus ? 4 : 0 }}>
        Session total {sessionTotal.toLocaleString()}
      </div>
      {!last && upNext && (
        <div style={{ fontSize: 15, color: "rgba(255,255,255,0.5)", marginTop: 4 }}>
          Up next:{" "}
          <span style={{ color: "#fff", fontWeight: 600 }}>
            {upNext.artist} — {upNext.title}
          </span>
        </div>
      )}
      <button style={{ ...primaryBtn(), marginTop: 16 }} onClick={onContinue}>
        {last ? "See the results ▶" : upNext ? "Next song ▶" : "Next — play another song ▶"}
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
            {multiplayer ? (
              summary.players.map((p) => (
                <th key={p.player} style={{ ...head, textAlign: "right" }}>
                  {p.player}
                </th>
              ))
            ) : (
              <>
                <th style={head}>Grade</th>
                <th style={{ ...head, textAlign: "right" }}>Score</th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {summary.rounds.map((r, i) => {
            const best = i === summary.bestRound?.index;
            // Highlight the per-round winner (only meaningful when >1 sang it).
            const roundWinner = [...r.scores].sort((a, b) => b.total - a.total)[0]?.player;
            return (
              <tr key={i} style={{ background: best ? `${GOLD}18` : "transparent" }}>
                <td style={{ ...cell, color: "rgba(255,255,255,0.5)" }}>{i + 1}</td>
                <td style={{ ...cell, textAlign: "left", fontWeight: 700 }}>
                  {r.title} {best && <span style={{ color: GOLD }}>★ best</span>}
                </td>
                {multiplayer ? (
                  summary.players.map((p) => {
                    const sc = r.scores.find((x) => x.player === p.player);
                    const win = !!sc && p.player === roundWinner && r.scores.length > 1;
                    return (
                      <td
                        key={p.player}
                        style={{
                          ...cell,
                          textAlign: "right",
                          fontVariantNumeric: "tabular-nums",
                          color: win ? GOLD : "#fff",
                          fontWeight: win ? 800 : 500,
                        }}
                      >
                        {sc ? sc.total.toLocaleString() : "—"}
                      </td>
                    );
                  })
                ) : (
                  <>
                    <td style={{ ...cell, color: GOLD }}>{stars(r.scores[0].grade.stars)}</td>
                    <td style={{ ...cell, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                      {r.scores[0].total.toLocaleString()}
                    </td>
                  </>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>

      <div style={{ display: "flex", gap: 12, marginTop: 20 }}>
        {onSave && (
          <button style={ghostBtn()} onClick={onSave}>
            💾 Save as playlist
          </button>
        )}
        <button style={primaryBtn()} onClick={onDone}>
          Done
        </button>
      </div>
    </Center>
  );
}

// ── shared bits ──────────────────────────────────────────────────────────────

function Center(props: { children: unknown; gap?: number; zoom?: number }) {
  const React = Spicetify.React;
  const zoom = props.zoom ?? 1;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: props.gap ?? 10,
        // One number scales a whole screen — type, padding, controls, gaps —
        // instead of hand-multiplying every size and missing some. It multiplies
        // with the root's UI_SCALE; percentages resolve in the zoomed space, so
        // height 100% still means "fill the parent" at any zoom.
        zoom: zoom === 1 ? undefined : zoom,
        height: "100%",
        overflowY: "auto",
        color: "#fff",
        textAlign: "center",
        fontFamily: "var(--font-family, 'Spotify Circular', system-ui, sans-serif)",
      }}
    >
      {props.children as never}
    </div>
  );
}

function primaryBtn(): Record<string, string | number> {
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
function ghostBtn(): Record<string, string | number> {
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
