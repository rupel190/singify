import { expect, test, describe } from "bun:test";
import { aggregateByMic, aggregateByPlayer, type StatRound } from "./stats";

const rounds: StatRound[] = [
  {
    t: 1,
    title: "A",
    artist: "X",
    difficulty: "easy",
    players: [
      { name: "P1", score: 8000, device: "USB Mic", gain: 1, sensitivity: 70 },
      { name: "P2", score: 6000, device: "Headset", gain: 1, sensitivity: 70 },
    ],
  },
  {
    t: 2,
    title: "B",
    artist: "Y",
    difficulty: "medium",
    players: [
      { name: "P1", score: 9000, device: "USB Mic", gain: 1, sensitivity: 70 },
      { name: "P2", score: 5000, device: "Headset", gain: 1, sensitivity: 70 },
    ],
  },
];

describe("aggregateByMic", () => {
  test("groups by device, best average first, with best song", () => {
    const mics = aggregateByMic(rounds);
    expect(mics.map((m) => m.device)).toEqual(["USB Mic", "Headset"]);
    expect(mics[0]).toMatchObject({ device: "USB Mic", rounds: 2, avg: 8500, best: 9000, bestSong: "Y — B" });
    expect(mics[1]).toMatchObject({ device: "Headset", rounds: 2, avg: 5500, best: 6000 });
  });

  test("empty input → empty output", () => {
    expect(aggregateByMic([])).toEqual([]);
  });

  test("blank device falls back to 'Default mic'", () => {
    const r: StatRound[] = [
      { t: 1, difficulty: "easy", players: [{ name: "P1", score: 100, device: "", gain: 1, sensitivity: 0 }] },
    ];
    expect(aggregateByMic(r)[0]!.device).toBe("Default mic");
  });
});

describe("aggregateByPlayer", () => {
  test("groups by name, best average first", () => {
    const players = aggregateByPlayer(rounds);
    expect(players.map((p) => p.name)).toEqual(["P1", "P2"]);
    expect(players[0]).toMatchObject({ name: "P1", rounds: 2, avg: 8500, best: 9000 });
    expect(players[1]).toMatchObject({ name: "P2", rounds: 2, avg: 5500, best: 6000 });
  });
});
