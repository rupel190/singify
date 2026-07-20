import { describe, test, expect } from "bun:test";
import {
  detectPitch,
  hzToMidi,
  midiToHz,
  pitchClass,
  foldToOctaveOf,
  createPitchSmoother,
} from "./pitch";

const SR = 44100;

/** A pure sine tone of `hz` for `n` samples at amplitude `amp`. */
function sine(hz: number, n = 2048, amp = 0.5): Float32Array {
  const buf = new Float32Array(n);
  for (let i = 0; i < n; i++) buf[i] = amp * Math.sin((2 * Math.PI * hz * i) / SR);
  return buf;
}

/** Sine plus a quieter octave + fifth, to look a bit more voice-like. */
function richTone(hz: number, n = 2048): Float32Array {
  const buf = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    buf[i] =
      0.5 * Math.sin(2 * Math.PI * hz * t) +
      0.25 * Math.sin(2 * Math.PI * 2 * hz * t) +
      0.12 * Math.sin(2 * Math.PI * 3 * hz * t);
  }
  return buf;
}

describe("Hz / MIDI / pitch-class conversion", () => {
  test("A4 (440 Hz) is MIDI 69", () => {
    expect(Math.round(hzToMidi(440))).toBe(69);
  });

  test("hz↔midi round-trips", () => {
    expect(midiToHz(69)).toBeCloseTo(440, 6);
    expect(hzToMidi(midiToHz(62))).toBeCloseTo(62, 6);
  });

  test("an octave is +12 semitones", () => {
    expect(hzToMidi(880) - hzToMidi(440)).toBeCloseTo(12, 6);
  });

  test("pitch class is octave-agnostic: D4 (62) == D5 (74)", () => {
    // The core of octave-agnostic scoring — same note, different octave.
    expect(pitchClass(62)).toBe(pitchClass(74));
    expect(pitchClass(62)).toBe(2); // D
  });
});

describe("detectPitch", () => {
  for (const hz of [110, 196, 261.63, 440, 660]) {
    test(`recovers a ${hz} Hz sine to the correct note`, () => {
      const r = detectPitch(sine(hz), { sampleRate: SR });
      expect(r).not.toBeNull();
      // Within a fraction of a semitone — i.e. rounds to the right note.
      expect(Math.abs(r!.midi - hzToMidi(hz))).toBeLessThan(0.4);
      expect(r!.clarity).toBeGreaterThan(0.9);
    });
  }

  test("recovers pitch from a harmonically rich (voice-like) tone", () => {
    const r = detectPitch(richTone(220), { sampleRate: SR });
    expect(r).not.toBeNull();
    expect(Math.round(r!.midi)).toBe(Math.round(hzToMidi(220))); // A3
  });

  test("silence returns null", () => {
    expect(detectPitch(new Float32Array(2048), { sampleRate: SR })).toBeNull();
  });

  test("sub-threshold amplitude returns null", () => {
    expect(detectPitch(sine(440, 2048, 0.001), { sampleRate: SR })).toBeNull();
  });

  test("frequency outside [minHz, maxHz] is rejected", () => {
    // 440 Hz tone but we only accept 600–1100 Hz → no confident reading.
    const r = detectPitch(sine(440), { sampleRate: SR, minHz: 600, maxHz: 1100 });
    expect(r).toBeNull();
  });
});

describe("foldToOctaveOf (octave-fold for the live marker)", () => {
  test("folds a low voice up into the chart's octave, same pitch class", () => {
    const f = foldToOctaveOf(45, 57, 69); // A2 sung against an A3–A4 chart
    expect(pitchClass(f)).toBe(pitchClass(45));
    expect(f).toBe(57); // A3
  });

  test("folds a high voice down", () => {
    expect(foldToOctaveOf(81, 57, 69)).toBe(69); // A5 → A4
  });

  test("aligns across the chart↔MIDI offset (a multiple of 12)", () => {
    // Real-chart space where 0≈C4: a sung MIDI 62 (D4) folds onto chart D (2).
    const f = foldToOctaveOf(62, -2, 12);
    expect(pitchClass(f)).toBe(pitchClass(62));
    expect(f).toBe(2);
  });

  test("a pitch already in range is unchanged", () => {
    expect(foldToOctaveOf(63, 57, 69)).toBe(63);
  });
});

describe("createPitchSmoother (marker smoothing)", () => {
  test("a steady input converges to that value", () => {
    const s = createPitchSmoother();
    let out = 0;
    for (let i = 0; i < 12; i++) out = s.push(60)!;
    expect(out).toBeCloseTo(60, 5);
  });

  test("a single-frame octave error is rejected by the median", () => {
    const s = createPitchSmoother();
    s.push(60);
    s.push(60);
    s.push(72); // spurious octave jump for one frame
    // Median of the recent window ignores the lone outlier — output stays low.
    expect(s.push(60)).toBeLessThan(63);
  });

  test("brief unvoiced gaps hold the last value, longer gaps drop it", () => {
    const s = createPitchSmoother({ holdFrames: 3 });
    for (let i = 0; i < 6; i++) s.push(60);
    expect(s.push(null)).toBeCloseTo(60, 5); // 1st null → hold
    expect(s.push(null)).toBeCloseTo(60, 5); // 2nd
    expect(s.push(null)).toBeCloseTo(60, 5); // 3rd (== holdFrames)
    expect(s.push(null)).toBeNull(); // 4th → give up, marker hides
  });

  test("EMA moves gradually toward a new sustained pitch (no instant jump)", () => {
    const s = createPitchSmoother();
    for (let i = 0; i < 10; i++) s.push(60);
    s.push(64); // one frame — rejected by the median, no movement yet
    const partial = s.push(64)!; // now the median sees 64; EMA eases toward it
    expect(partial).toBeGreaterThan(60);
    expect(partial).toBeLessThan(64); // gradual, not an instant snap
    let out = partial;
    for (let i = 0; i < 12; i++) out = s.push(64)!;
    expect(out).toBeCloseTo(64, 1); // eventually settles
  });

  test("reset clears state", () => {
    const s = createPitchSmoother();
    for (let i = 0; i < 6; i++) s.push(60);
    s.reset();
    expect(s.push(70)).toBeCloseTo(70, 5); // fresh — no memory of 60
  });
});
