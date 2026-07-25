import { describe, test, expect } from "bun:test";
import {
  createSession,
  createSessionFromPlaylist,
  isPlaylistSession,
  upNext,
  recordRound,
  roundFromScore,
  roundsLeft,
  isComplete,
  summarize,
  type RoundResult,
  type SessionTrack,
} from "./session";
import type { ScoreState } from "./scoring";

function score(total: number, sung = 10, notesTotal = 10): ScoreState {
  return { total, notesSung: sung, notesTotal } as ScoreState;
}
function round(title: string, total: number, player = "You"): RoundResult {
  return { title, artist: "A", scores: [{ player, total, grade: "A" as never, notesSung: 0, notesTotal: 0 }] };
}

describe("session state", () => {
  test("createSession clamps rounds to >= 1 and defaults the player", () => {
    const s = createSession(0);
    expect(s.targetRounds).toBe(1);
    expect(s.players).toEqual(["You"]);
    expect(s.rounds).toEqual([]);
  });

  test("recordRound is immutable and appends", () => {
    const s0 = createSession(3);
    const s1 = recordRound(s0, round("A", 100));
    expect(s0.rounds.length).toBe(0); // original untouched
    expect(s1.rounds.length).toBe(1);
  });

  test("roundsLeft / isComplete track progress against the target", () => {
    let s = createSession(2);
    expect(roundsLeft(s)).toBe(2);
    expect(isComplete(s)).toBe(false);
    s = recordRound(s, round("A", 100));
    expect(roundsLeft(s)).toBe(1);
    s = recordRound(s, round("B", 200));
    expect(roundsLeft(s)).toBe(0);
    expect(isComplete(s)).toBe(true);
  });

  test("roundFromScore carries the total, counts, and a computed grade", () => {
    const r = roundFromScore("Code Monkey", "Jonathan Coulton", score(9500, 40, 44));
    expect(r.title).toBe("Code Monkey");
    expect(r.scores).toHaveLength(1);
    expect(r.scores[0].total).toBe(9500);
    expect(r.scores[0].notesSung).toBe(40);
    expect(r.scores[0].grade.name).toBe("Superstar"); // 9500 → top tier
    expect(r.scores[0].grade.stars).toBe(5);
  });
});

describe("playlist-sourced session", () => {
  const tracks: SessionTrack[] = [
    { uri: "spotify:track:1", title: "One", artist: "A" },
    { uri: "spotify:track:2", title: "Two", artist: "B" },
    { uri: "spotify:track:3", title: "Three", artist: "C" },
  ];

  test("round count is the playlist length", () => {
    const s = createSessionFromPlaylist("Party Bangers", tracks);
    expect(s.targetRounds).toBe(3);
    expect(s.playlistName).toBe("Party Bangers");
    expect(isPlaylistSession(s)).toBe(true);
  });

  test("count-mode sessions are not playlist sessions", () => {
    expect(isPlaylistSession(createSession(5))).toBe(false);
    expect(upNext(createSession(5))).toBeNull();
  });

  test("upNext walks the list as rounds are recorded", () => {
    let s = createSessionFromPlaylist("P", tracks);
    expect(upNext(s)?.title).toBe("One"); // round 1 source
    s = recordRound(s, round("One", 100));
    expect(upNext(s)?.title).toBe("Two"); // round 2 source
    s = recordRound(s, round("Two", 100));
    expect(upNext(s)?.title).toBe("Three");
    s = recordRound(s, round("Three", 100));
    expect(upNext(s)).toBeNull(); // list spent
    expect(isComplete(s)).toBe(true);
  });

  test("copies the track list (immune to later caller mutation)", () => {
    const src = tracks.slice();
    const s = createSessionFromPlaylist("P", src);
    src.push({ uri: "spotify:track:9", title: "Nine", artist: "Z" });
    expect(s.playlist).toHaveLength(3);
  });

  test("empty playlist clamps to a 1-round session", () => {
    const s = createSessionFromPlaylist("Empty", []);
    expect(s.targetRounds).toBe(1);
    expect(isPlaylistSession(s)).toBe(false); // nothing to source
    expect(upNext(s)).toBeNull();
  });
});

describe("summarize", () => {
  test("sums totals, averages, and finds the best round", () => {
    let s = createSession(3);
    s = recordRound(s, round("A", 6000));
    s = recordRound(s, round("B", 9000));
    s = recordRound(s, round("C", 3000));
    const sum = summarize(s);
    expect(sum.players[0].total).toBe(18000);
    expect(sum.players[0].avg).toBe(6000);
    expect(sum.bestRound).toEqual({ title: "B", player: "You", total: 9000 });
  });

  test("is multiplayer-shaped: a column per player", () => {
    const s: ReturnType<typeof createSession> = {
      targetRounds: 1,
      players: ["P1", "P2"],
      rounds: [
        {
          title: "A",
          artist: "x",
          scores: [
            { player: "P1", total: 8000, grade: "B" as never, notesSung: 0, notesTotal: 0 },
            { player: "P2", total: 5000, grade: "C" as never, notesSung: 0, notesTotal: 0 },
          ],
        },
      ],
    };
    const sum = summarize(s);
    expect(sum.players.map((p) => p.player)).toEqual(["P1", "P2"]);
    expect(sum.players[0].total).toBe(8000);
    expect(sum.players[1].total).toBe(5000);
    expect(sum.bestRound?.player).toBe("P1");
  });
});
