import { describe, test, expect } from "bun:test";
import { parse, getPosition, getPitchRange } from "./ultrastar-parser";

// ── Fixtures ───────────────────────────────────────────────────────────────

const MINIMAL_SONG = `
#TITLE:Test Song
#ARTIST:Test Artist
#BPM:120
#GAP:1000
: 0 4 55 Hel-
: 4 4 55 lo
- 16
: 16 4 60 World
E
`.trim();

// BPM=120, so msPerBeat = 60000 / (120*4) = 125ms
// beat 0  → GAP + 0   = 1000ms
// beat 4  → GAP + 500 = 1500ms
// beat 16 → GAP + 2000 = 3000ms

const GOLDEN_SONG = `
#TITLE:Golden
#ARTIST:Artist
#BPM:200
#GAP:500
: 0 2 60 nor-
* 2 2 65 mal
F 4 2 0 free-
: 6 2 55 style
E
`.trim();

// BPM=200 → msPerBeat = 60000 / (200*4) = 75ms

const RELATIVE_SONG = `
#TITLE:Relative
#ARTIST:Artist
#BPM:120
#GAP:0
#RELATIVE:YES
: 0 4 50 Line-
: 4 4 50 one
- 10
: 0 4 55 Li-
: 4 4 55 ne-two
E
`.trim();

// RELATIVE: line 2 syllables start at absoluteBeat=10+0=10, 10+4=14
// msPerBeat=125ms → line2 starts at 1250ms

const COMMA_BPM = `
#TITLE:European BPM
#ARTIST:Test
#BPM:100,00
#GAP:0
: 0 8 60 Hello
E
`.trim();

// European locale uses comma as decimal separator; should still parse

// ── Header parsing ─────────────────────────────────────────────────────────

describe("parse() headers", () => {
  test("extracts title and artist", () => {
    const song = parse(MINIMAL_SONG);
    expect(song.headers.title).toBe("Test Song");
    expect(song.headers.artist).toBe("Test Artist");
  });

  test("parses BPM and GAP as numbers", () => {
    const song = parse(MINIMAL_SONG);
    expect(song.headers.bpm).toBe(120);
    expect(song.headers.gap).toBe(1000);
  });

  test("handles European comma decimal in BPM", () => {
    const song = parse(COMMA_BPM);
    expect(song.headers.bpm).toBe(100);
  });

  test("relative flag parsed correctly", () => {
    expect(parse(MINIMAL_SONG).headers.relative).toBe(false);
    expect(parse(RELATIVE_SONG).headers.relative).toBe(true);
  });

  test("throws on missing BPM", () => {
    const noBpm = MINIMAL_SONG.replace("#BPM:120\n", "");
    expect(() => parse(noBpm)).toThrow("Invalid or missing #BPM");
  });
});

// ── Line / syllable structure ──────────────────────────────────────────────

describe("parse() lines", () => {
  test("splits into correct number of lines", () => {
    const song = parse(MINIMAL_SONG);
    expect(song.lines.length).toBe(2);
  });

  test("first line has 2 syllables", () => {
    const song = parse(MINIMAL_SONG);
    expect(song.lines[0].syllables.length).toBe(2);
  });

  test("second line has 1 syllable", () => {
    const song = parse(MINIMAL_SONG);
    expect(song.lines[1].syllables.length).toBe(1);
  });

  test("syllable text preserved", () => {
    const song = parse(MINIMAL_SONG);
    expect(song.lines[0].syllables[0].text).toBe("Hel-");
    expect(song.lines[0].syllables[1].text).toBe("lo");
  });
});

// ── Timing ─────────────────────────────────────────────────────────────────

describe("beat-to-ms conversion", () => {
  test("first syllable starts at GAP when beat=0", () => {
    const song = parse(MINIMAL_SONG);
    // GAP=1000, beat=0 → 1000ms
    expect(song.lines[0].syllables[0].startMs).toBe(1000);
  });

  test("second syllable starts at GAP + 4 beats", () => {
    const song = parse(MINIMAL_SONG);
    // BPM=120, msPerBeat=125ms; beat=4 → GAP + 4*125 = 1500ms
    expect(song.lines[0].syllables[1].startMs).toBe(1500);
  });

  test("second line syllable at correct absolute time", () => {
    const song = parse(MINIMAL_SONG);
    // beat=16 → GAP + 16*125 = 1000 + 2000 = 3000ms
    expect(song.lines[1].syllables[0].startMs).toBe(3000);
  });

  test("duration converts correctly", () => {
    const song = parse(MINIMAL_SONG);
    // duration=4 beats → 4*125 = 500ms
    expect(song.lines[0].syllables[0].durationMs).toBe(500);
  });

  test("line startMs and endMs are correct", () => {
    const song = parse(MINIMAL_SONG);
    const line = song.lines[0];
    expect(line.startMs).toBe(1000);
    // last syllable: start=1500, duration=500 → end=2000
    expect(line.endMs).toBe(2000);
  });

  test("durationMs is total song end time", () => {
    const song = parse(MINIMAL_SONG);
    // last syllable: beat=16, duration=4 → 3000 + 500 = 3500ms
    expect(song.durationMs).toBe(3500);
  });
});

// ── Note types ─────────────────────────────────────────────────────────────

describe("note types", () => {
  test("normal notes parsed", () => {
    const song = parse(GOLDEN_SONG);
    expect(song.lines[0].syllables[0].type).toBe("normal");
  });

  test("golden notes parsed", () => {
    const song = parse(GOLDEN_SONG);
    expect(song.lines[0].syllables[1].type).toBe("golden");
  });

  test("freestyle notes parsed", () => {
    const song = parse(GOLDEN_SONG);
    expect(song.lines[0].syllables[2].type).toBe("freestyle");
  });

  test("pitch stored on syllable", () => {
    const song = parse(GOLDEN_SONG);
    expect(song.lines[0].syllables[0].pitch).toBe(60);
    expect(song.lines[0].syllables[1].pitch).toBe(65);
  });
});

// ── RELATIVE mode ─────────────────────────────────────────────────────────

describe("RELATIVE mode", () => {
  test("line 1 starts at beat 0 (absolute 0)", () => {
    const song = parse(RELATIVE_SONG);
    // GAP=0, beat 0 → 0ms
    expect(song.lines[0].syllables[0].startMs).toBe(0);
  });

  test("line 2 syllable 1 offset by line break beat", () => {
    const song = parse(RELATIVE_SONG);
    // Line break = 10, then local beat 0 → absolute beat 10 → 10*125 = 1250ms
    expect(song.lines[1].syllables[0].startMs).toBe(1250);
  });

  test("line 2 syllable 2 offset by line break + local beat", () => {
    const song = parse(RELATIVE_SONG);
    // absolute beat = 10 + 4 = 14 → 14*125 = 1750ms
    expect(song.lines[1].syllables[1].startMs).toBe(1750);
  });
});

// ── getPosition() ──────────────────────────────────────────────────────────

describe("getPosition()", () => {
  test("returns active syllable during note", () => {
    const song = parse(MINIMAL_SONG);
    // First syllable: 1000–1500ms
    const pos = getPosition(song, 1200);
    expect(pos.lineIndex).toBe(0);
    expect(pos.syllableIndex).toBe(0);
  });

  test("returns -1 syllable between notes", () => {
    const song = parse(MINIMAL_SONG);
    // Between line1 end (2000ms) and line2 start (3000ms)
    const pos = getPosition(song, 2500);
    expect(pos.syllableIndex).toBe(-1);
  });

  test("nextSyllableMs is correct when between notes", () => {
    const song = parse(MINIMAL_SONG);
    // At 2500ms, next syllable starts at 3000ms → 500ms away
    const pos = getPosition(song, 2500);
    expect(pos.nextSyllableMs).toBe(500);
  });

  test("handles position before song start", () => {
    const song = parse(MINIMAL_SONG);
    const pos = getPosition(song, 0);
    expect(pos.syllableIndex).toBe(-1);
    expect(pos.lineIndex).toBe(0);  // approaching first line
  });
});

// ── getPitchRange() ────────────────────────────────────────────────────────

describe("getPitchRange()", () => {
  test("returns correct min/max pitches", () => {
    const song = parse(MINIMAL_SONG);
    // pitches: 55, 55, 60
    expect(getPitchRange(song)).toEqual([55, 60]);
  });

  test("excludes freestyle notes from range", () => {
    const song = parse(GOLDEN_SONG);
    // notes: 60 (normal), 65 (golden), 0 (freestyle), 55 (normal)
    // freestyle (pitch=0) should be excluded
    expect(getPitchRange(song)).toEqual([55, 65]);
  });
});
