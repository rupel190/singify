import { describe, test, expect } from "bun:test";
import { parse } from "./ultrastar-parser";
import {
  autoSync,
  alignWords,
  chartWords,
  normalizeWord,
  offsetAt,
  isConfident,
  isMismatch,
  type LyricLine,
} from "./autosync";

// A lyric of 16 distinct-ish lines with a repeated chorus, so ordering matters.
const VERSE = [
  "the morning light is breaking through",
  "i walk the empty streets alone",
  "the city hums a quiet tune",
  "and every window shines like gold",
];
const CHORUS = ["oh we are running out of time", "so hold me close and never let go"];
const LYRIC = [...VERSE, ...CHORUS, ...VERSE.map((l) => l.replace("the", "a")), ...CHORUS, ...CHORUS];

/**
 * Build an UltraStar chart (BPM 300 → 50 ms/beat) with one syllable per word,
 * plus Spotify lines for the same lyric, from a function giving each line's
 * Spotify start and its chart start.
 */
function fixture(times: (i: number) => { spotifyMs: number; chartMs: number }) {
  const msPerBeat = 50;
  let body = "#TITLE:T\n#ARTIST:A\n#BPM:300\n#GAP:0\n";
  const lines: LyricLine[] = [];
  LYRIC.forEach((text, i) => {
    const { spotifyMs, chartMs } = times(i);
    lines.push({ startMs: spotifyMs, words: text });
    let beat = Math.round(chartMs / msPerBeat);
    text.split(" ").forEach((w, k) => {
      body += `: ${beat} 4 0 ${k ? " " : ""}${w}\n`;
      beat += 6;
    });
    body += `- ${beat + 2}\n`;
  });
  return { song: parse(body + "E\n"), lines };
}

describe("text normalisation", () => {
  test("folds case, accents, umlauts and punctuation", () => {
    expect(normalizeWord("Über-Ärger!")).toBe("uberarger");
    expect(normalizeWord("Straße,")).toBe("strasse");
    expect(normalizeWord("~")).toBe("");
  });

  test("chart syllables join into timed words at spaces", () => {
    const song = parse("#TITLE:T\n#ARTIST:A\n#BPM:60\n#GAP:0\n: 0 2 0 Hel\n: 2 2 0 lo \n: 4 2 0 world~\n: 6 2 0 ~\n- 9\n: 10 2 0 Bye\nE\n");
    expect(chartWords(song).map((w) => w.w)).toEqual(["hello", "world", "bye"]);
    expect(chartWords(song)[1].ms).toBe(1000);
  });
});

describe("word alignment", () => {
  test("pairs repeated words in order, skipping extras on either side", () => {
    const a = ["x", "oh", "we", "are", "y", "oh", "we", "are"];
    const b = ["oh", "we", "are", "oh", "we", "are", "z"];
    expect(alignWords(a, b)).toEqual([
      [1, 0], [2, 1], [3, 2], [5, 3], [6, 4], [7, 5],
    ]);
  });
});

describe("autoSync", () => {
  test("recovers a constant offset and is confident about it", () => {
    const { song, lines } = fixture((i) => ({ spotifyMs: 5000 + i * 4000, chartMs: 49000 + i * 4000 }));
    const r = autoSync(song, lines)!;
    expect(r.shape).toBe("constant");
    expect(Math.abs(r.offsetMs - 44000)).toBeLessThan(60);
    expect(isConfident(r)).toBe(true);
    expect(isMismatch(r)).toBe(false);
  });

  test("detects tempo drift and models it as a sloped curve", () => {
    // The chart runs 3 % slow: the offset grows as the song goes on.
    const { song, lines } = fixture((i) => {
      const s = 5000 + i * 4000;
      return { spotifyMs: s, chartMs: s * 1.03 + 2000 };
    });
    const r = autoSync(song, lines)!;
    expect(r.shape).toBe("drift");
    expect(r.slope).toBeGreaterThan(0.025);
    expect(r.slope).toBeLessThan(0.035);
    expect(isConfident(r)).toBe(false);
    expect(isMismatch(r)).toBe(true);
    const late = lines[lines.length - 1].startMs;
    expect(Math.abs(offsetAt(r.curve, late) - (late * 0.03 + 2000))).toBeLessThan(150);
  });

  test("detects a step when the chart has an extra section", () => {
    // From line 6 on, the chart is 5 s further along than Spotify (a longer break).
    const { song, lines } = fixture((i) => ({
      spotifyMs: 5000 + i * 4000,
      chartMs: 12000 + i * 4000 + (i >= 6 ? 5000 : 0),
    }));
    const r = autoSync(song, lines)!;
    expect(r.shape).toBe("step");
    expect(isMismatch(r)).toBe(true);
    expect(Math.abs(offsetAt(r.curve, lines[1].startMs) - 7000)).toBeLessThan(100);
    expect(Math.abs(offsetAt(r.curve, lines[12].startMs) - 12000)).toBeLessThan(100);
  });

  test("returns null when there's too little to match", () => {
    const { song } = fixture((i) => ({ spotifyMs: i * 4000, chartMs: i * 4000 }));
    expect(autoSync(song, [{ startMs: 0, words: "hello" }])).toBeNull();
  });

  test("unrelated lyrics give no confident suggestion", () => {
    const { song } = fixture((i) => ({ spotifyMs: i * 4000, chartMs: i * 4000 }));
    const other: LyricLine[] = Array.from({ length: 20 }, (_, i) => ({
      startMs: i * 3000,
      words: `completely different words number ${i} here today`,
    }));
    const r = autoSync(song, other);
    expect(r == null || !isConfident(r)).toBe(true);
  });
});

describe("offsetAt", () => {
  test("interpolates between knots and holds flat past the ends", () => {
    const c = [
      { atMs: 1000, offsetMs: 100 },
      { atMs: 3000, offsetMs: 300 },
    ];
    expect(offsetAt(c, 0)).toBe(100);
    expect(offsetAt(c, 2000)).toBe(200);
    expect(offsetAt(c, 9000)).toBe(300);
  });
});
