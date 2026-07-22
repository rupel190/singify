import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalCharts } from "./local-charts";

/** Minimal valid UltraStar chart (parser needs a positive #BPM + a note). */
function chart(artist: string, title: string): string {
  return [
    `#TITLE:${title}`,
    `#ARTIST:${artist}`,
    "#BPM:120",
    "#GAP:0",
    ": 0 4 0 la",
    ": 4 4 2 la",
    "E",
    "",
  ].join("\n");
}

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "singify-charts-"));
  writeFileSync(join(dir, "code-monkey.txt"), chart("Jonathan Coulton", "Code Monkey"));
  writeFileSync(join(dir, "blank-space.txt"), chart("Taylor Swift", "Blank Space"));
  writeFileSync(join(dir, "notes.md"), "not a chart"); // ignored (wrong ext)
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("createLocalCharts", () => {
  test("indexes only .txt charts", () => {
    expect(createLocalCharts(dir).count()).toBe(2);
  });

  test("matches the right chart for a track", () => {
    const m = createLocalCharts(dir).resolve("Jonathan Coulton", "Code Monkey");
    expect(m).not.toBeNull();
    expect(m!.song.headers.title).toBe("Code Monkey");
    expect(m!.score).toBeGreaterThan(0.85);
  });

  test("tolerates Spotify-style noise in the query", () => {
    // sanitizeQuery strips the feature/remaster cruft before fuzzy matching.
    const m = createLocalCharts(dir).resolve(
      "Jonathan Coulton feat. Someone",
      "Code Monkey - Remastered 2011"
    );
    expect(m?.song.headers.title).toBe("Code Monkey");
  });

  test("returns null when nothing clears the threshold", () => {
    expect(createLocalCharts(dir).resolve("Metallica", "One")).toBeNull();
  });

  test("picks up a chart dropped in after construction", () => {
    const lc = createLocalCharts(dir);
    expect(lc.resolve("Radiohead", "Creep")).toBeNull();
    writeFileSync(join(dir, "creep.txt"), chart("Radiohead", "Creep"));
    expect(lc.resolve("Radiohead", "Creep")?.song.headers.artist).toBe("Radiohead");
  });

  test("missing folder → empty index, no throw", () => {
    const lc = createLocalCharts(join(dir, "does-not-exist"));
    expect(lc.count()).toBe(0);
    expect(lc.resolve("Anyone", "Anything")).toBeNull();
  });

  test("scans multiple folders and skips missing ones", () => {
    const dir2 = mkdtempSync(join(tmpdir(), "singify-charts2-"));
    writeFileSync(join(dir2, "one.txt"), chart("Metallica", "One"));
    try {
      // A missing folder sits between two real ones — it must be skipped, and
      // charts from BOTH real folders must resolve (union, not first-wins).
      const lc = createLocalCharts([dir, join(dir, "nope"), dir2]);
      expect(lc.resolve("Jonathan Coulton", "Code Monkey")?.song.headers.title).toBe(
        "Code Monkey"
      );
      expect(lc.resolve("Metallica", "One")?.song.headers.artist).toBe("Metallica");
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });
});
