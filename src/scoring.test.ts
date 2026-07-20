import { describe, test, expect } from "bun:test";
import { parse } from "./ultrastar-parser";
import { createScoreKeeper, toleranceSemitones, gradeForScore } from "./scoring";

// BPM=60 → msPerBeat = 60000 / (60*4) = 250ms.
// note a: 0–1000ms  pitch 0  normal  weight 4×1=4  → max 2250
// note b: 1000–2000  pitch 12 golden weight 4×2=8  → max 4500  (line 0 with a)
// note c: 2000–3000  pitch 0  normal weight 4×1=4  → max 2250  (line 1)
// totalWeight 16; lines with notes: 2 → line bonus 500 each.
const SONG = parse(
  `#TITLE:S
#ARTIST:A
#BPM:60
#GAP:0
: 0 4 0 a
* 4 4 12 b
- 8
: 8 4 0 c
E`
);

/** Feed `frames` evenly-spaced samples across [startMs, endMs) at `midi`. */
function singNote(
  keeper: ReturnType<typeof createScoreKeeper>,
  startMs: number,
  endMs: number,
  midi: number | null,
  frames = 10
): void {
  const step = (endMs - startMs) / frames;
  for (let i = 0; i < frames; i++) keeper.sample(startMs + i * step, midi);
}

describe("gradeForScore", () => {
  test("maps score bands to named tiers", () => {
    expect(gradeForScore(10000).name).toBe("Superstar");
    expect(gradeForScore(9000).name).toBe("Superstar");
    expect(gradeForScore(8999).name).toBe("Lead Singer");
    expect(gradeForScore(6000).name).toBe("Rising Star");
    expect(gradeForScore(4000).name).toBe("Hopeful");
    expect(gradeForScore(2000).name).toBe("Amateur");
    expect(gradeForScore(0).name).toBe("Tone Deaf");
  });
  test("stars rise with the tier", () => {
    expect(gradeForScore(10000).stars).toBe(5);
    expect(gradeForScore(0).stars).toBe(0);
  });
});

describe("toleranceSemitones", () => {
  test("shrinks with difficulty", () => {
    expect(toleranceSemitones("easy")).toBe(2);
    expect(toleranceSemitones("medium")).toBe(1);
    expect(toleranceSemitones("hard")).toBe(0);
  });
});

describe("createScoreKeeper", () => {
  test("a perfect run scores ~10000", () => {
    const k = createScoreKeeper(SONG);
    singNote(k, 0, 1000, 0); // a
    singNote(k, 1000, 2000, 12); // b (golden)
    singNote(k, 2000, 3000, 0); // c
    const s = k.read();
    expect(s.total).toBe(10000);
    expect(s.notePoints).toBe(9000);
    expect(s.linePoints).toBe(1000);
    expect(s.notesSung).toBe(3);
    expect(s.notesTotal).toBe(3);
  });

  test("silence scores nothing", () => {
    const k = createScoreKeeper(SONG);
    singNote(k, 0, 1000, null);
    singNote(k, 1000, 2000, null);
    singNote(k, 2000, 3000, null);
    expect(k.read().total).toBe(0);
  });

  test("golden notes are worth double a normal note of equal length", () => {
    // Sing only the golden note (b) perfectly, nothing else.
    const golden = createScoreKeeper(SONG);
    singNote(golden, 1000, 2000, 12);
    // Sing only the equal-length normal note (a) perfectly, nothing else.
    const normal = createScoreKeeper(SONG);
    singNote(normal, 0, 1000, 0);
    expect(golden.read().notePoints).toBe(4500);
    expect(normal.read().notePoints).toBe(2250);
    expect(golden.read().notePoints).toBe(2 * normal.read().notePoints);
  });

  test("partial credit is proportional to time held on-pitch", () => {
    const k = createScoreKeeper(SONG);
    // First half of note a on-pitch, second half silent → ~50% credit.
    singNote(k, 0, 500, 0, 5);
    singNote(k, 500, 1000, null, 5);
    // a's max is 2250 → expect ~1125 note points from it.
    expect(k.read().notePoints).toBe(Math.round(2250 * 0.5));
  });

  test("octave errors still count as hits", () => {
    // note b target pitch is 12; singing it an octave up/down must still hit.
    const up = createScoreKeeper(SONG);
    singNote(up, 1000, 2000, 12 + 12);
    const down = createScoreKeeper(SONG);
    singNote(down, 1000, 2000, 12 - 12);
    expect(up.read().notePoints).toBe(4500);
    expect(down.read().notePoints).toBe(4500);
  });

  test("tolerance band tightens with difficulty", () => {
    // note a target 0; sing 2 semitones sharp.
    const easy = createScoreKeeper(SONG, "easy"); // ±2 → hit
    singNote(easy, 0, 1000, 2);
    const hard = createScoreKeeper(SONG, "hard"); // ±0 → miss
    singNote(hard, 0, 1000, 2);
    expect(easy.read().notePoints).toBe(2250);
    expect(hard.read().notePoints).toBe(0);
  });

  test("samples in a gap between notes are ignored", () => {
    const k = createScoreKeeper(SONG);
    // 3200ms is after the last note ends (3000ms) — no active note.
    k.sample(3200, 0);
    expect(k.read().total).toBe(0);
    expect(k.read().notesSung).toBe(0);
  });

  test("a freestyle-only song never divides by zero", () => {
    const free = parse(`#TITLE:x\n#ARTIST:y\n#BPM:120\n#GAP:0\nF 0 4 0 la\nE`);
    const k = createScoreKeeper(free);
    singNote(k, 0, 500, 5);
    const s = k.read();
    expect(s.total).toBe(0);
    expect(s.notesTotal).toBe(0);
  });

  test("reset clears accumulated hits", () => {
    const k = createScoreKeeper(SONG);
    singNote(k, 0, 1000, 0);
    expect(k.read().notePoints).toBeGreaterThan(0);
    k.reset();
    expect(k.read().total).toBe(0);
  });
});
