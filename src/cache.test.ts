import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  sanitizeQuery,
  cleanTitle,
  cleanArtist,
  fuzzyMatch,
  saveSong,
  loadSong,
  isCached,
  setCacheDir,
} from "./cache";

const SAMPLE_TXT = `#TITLE:Hello
#ARTIST:Adele
#BPM:120
#GAP:0
: 0 4 60 Hel-
: 4 4 60 lo
E`;

beforeEach(() => {
  setCacheDir(mkdtempSync(join(tmpdir(), "sk-cache-")));
});

// ── Query normalisation ──────────────────────────────────────────────────────

describe("cleanTitle", () => {
  test("strips feat.", () => {
    expect(cleanTitle("Umbrella (feat. Jay-Z)")).toBe("umbrella");
    expect(cleanTitle("Umbrella feat. Jay-Z")).toBe("umbrella");
  });

  test("strips remaster / radio edit noise parens", () => {
    expect(cleanTitle("Bohemian Rhapsody (Remastered 2011)")).toBe(
      "bohemian rhapsody"
    );
    expect(cleanTitle("Song (Radio Edit)")).toBe("song");
  });

  test("strips trailing - Remaster dash segment", () => {
    expect(cleanTitle("Come Together - 2019 Remaster")).toBe("come together");
    expect(cleanTitle("Wish You Were Here - Single Version")).toBe(
      "wish you were here"
    );
  });

  test("keeps meaningful parens", () => {
    expect(cleanTitle("Sign of the Times")).toBe("sign of the times");
  });
});

describe("cleanArtist", () => {
  test("keeps only primary artist", () => {
    expect(cleanArtist("Rihanna feat. Jay-Z")).toBe("rihanna");
    expect(cleanArtist("Calvin Harris & Dua Lipa")).toBe("calvin harris");
    expect(cleanArtist("Jack U, Justin Bieber")).toBe("jack u");
  });
});

describe("sanitizeQuery", () => {
  test("returns cleaned title + artist", () => {
    expect(
      sanitizeQuery("One Kiss (feat. Dua Lipa)", "Calvin Harris & Dua Lipa")
    ).toEqual({ title: "one kiss", artist: "calvin harris" });
  });
});

// ── Fuzzy matching ───────────────────────────────────────────────────────────

describe("fuzzyMatch", () => {
  test("identical strings score 1", () => {
    expect(fuzzyMatch("Hello", "hello")).toBe(1);
  });

  test("case / diacritic insensitive", () => {
    expect(fuzzyMatch("Beyoncé", "Beyonce")).toBe(1);
  });

  test("near matches score high", () => {
    expect(fuzzyMatch("Bohemian Rhapsody", "Bohemian Rapsody")).toBeGreaterThan(
      0.85
    );
  });

  test("word-reordered strings still score well via token overlap", () => {
    expect(fuzzyMatch("Rhapsody Bohemian", "Bohemian Rhapsody")).toBeGreaterThan(
      0.5
    );
  });

  test("unrelated strings score low", () => {
    expect(fuzzyMatch("Umbrella", "Thunderstruck")).toBeLessThan(0.4);
  });
});

// ── Persistence roundtrip ────────────────────────────────────────────────────

describe("saveSong / loadSong", () => {
  test("roundtrips a saved song", async () => {
    await saveSong("spotify:track:abc", 12345, "Adele", "Hello", SAMPLE_TXT);

    expect(await isCached("spotify:track:abc")).toBe(true);
    const song = await loadSong("spotify:track:abc");
    expect(song).not.toBeNull();
    expect(song!.headers.title).toBe("Hello");
    expect(song!.lines[0].syllables.length).toBe(2);
  });

  test("loadSong returns null for unknown track", async () => {
    expect(await loadSong("spotify:track:missing")).toBeNull();
    expect(await isCached("spotify:track:missing")).toBe(false);
  });

  test("sanitizes illegal filename characters", async () => {
    // Slashes in title must not create nested dirs / break the write.
    await saveSong("id1", 7, "AC/DC", "Hells: Bells?", SAMPLE_TXT);
    const song = await loadSong("id1");
    expect(song).not.toBeNull();
  });
});
