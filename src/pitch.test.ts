import { describe, test, expect } from "bun:test";
import {
  detectPitch,
  hzToMidi,
  midiToHz,
  pitchClass,
  foldToOctaveOf,
  createPitchSmoother,
  foldSmoothHit,
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

// ── Marker path (foldSmoothHit): fold-to-target THEN smooth ──────────────────
// These pin down the ordering fix. Smoothing the absolute pitch first would let
// an octave flicker average into garbage; folding first keeps a steady note
// steady. Series are deterministic so the tests are reproducible.
describe("foldSmoothHit", () => {
  test("octave flicker on a steady note stays pinned to the target (the fix)", () => {
    const sm = createPitchSmoother();
    const TARGET = 57; // A3; detector drops to the octave-below (45) on some frames
    const flicker = [57, 57, 45, 57, 45, 45, 57, 57, 45, 57, 57, 45, 57];
    let last = { pitch: null as number | null, hit: false };
    for (const m of flicker) last = foldSmoothHit(sm, m, TARGET, 2);
    expect(last.hit).toBe(true);
    expect(last.pitch).toBe(TARGET); // snapped — not an averaged in-between value
  });

  test("a single non-octave outlier (a fifth) is rejected by the median", () => {
    const sm = createPitchSmoother();
    const TARGET = 57;
    const series = [57, 57, 64, 57, 57]; // one spurious +7 frame
    let last = { pitch: null as number | null, hit: false };
    for (const m of series) last = foldSmoothHit(sm, m, TARGET, 2);
    expect(last.hit).toBe(true);
    expect(last.pitch).toBe(TARGET);
  });

  test("a genuine miss reports a folded pitch near the target, not a hit", () => {
    const sm = createPitchSmoother();
    let last = { pitch: null as number | null, hit: false };
    for (let i = 0; i < 6; i++) last = foldSmoothHit(sm, 62, 57, 2); // singing a D against A
    expect(last.hit).toBe(false);
    expect(last.pitch).toBeCloseTo(62, 0);
  });

  test("brief dropouts hold the marker instead of blinking it off", () => {
    const sm = createPitchSmoother({ holdFrames: 2 });
    for (let i = 0; i < 5; i++) foldSmoothHit(sm, 57, 57, 2);
    expect(foldSmoothHit(sm, null, 57, 2).pitch).not.toBeNull(); // held through the gap
  });
});

// ── Detector stability on realistic voice-like tones ─────────────────────────
// A steady sung note fed through overlapping analysis windows should detect the
// right note on nearly every frame with low frame-to-frame jitter — even with
// vibrato, breath noise, and harmonic profiles that could fool autocorrelation.
describe("detectPitch stability across frames", () => {
  const WIN = 2048;
  const HOP = 735; // ~60 fps at 44.1 kHz

  function voice(
    hz: number,
    durSec: number,
    opts: { harmonics?: number[]; vibratoCents?: number; noise?: number } = {}
  ): Float32Array {
    const { harmonics = [1, 0.6, 0.4, 0.25, 0.15], vibratoCents = 0, noise = 0 } = opts;
    const n = Math.floor(SR * durSec);
    const buf = new Float32Array(n);
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const vib = vibratoCents
        ? Math.pow(2, (vibratoCents / 1200) * Math.sin(2 * Math.PI * 5.5 * t))
        : 1;
      phase += (2 * Math.PI * hz * vib) / SR;
      let s = 0;
      for (let k = 0; k < harmonics.length; k++) s += harmonics[k] * Math.sin((k + 1) * phase);
      if (noise) s += noise * (Math.sin(i * 12.9898) * 43758.5453 % 1); // deterministic pseudo-noise
      buf[i] = 0.4 * s;
    }
    return buf;
  }

  function analyse(sig: Float32Array, trueMidi: number) {
    let frames = 0,
      good = 0,
      pcErr = 0;
    const midis: number[] = [];
    for (let start = 0; start + WIN <= sig.length; start += HOP) {
      const r = detectPitch(sig.subarray(start, start + WIN), { sampleRate: SR });
      frames++;
      if (!r) continue;
      midis.push(r.midi);
      const dPc = (((Math.round(r.midi - trueMidi)) % 12) + 12) % 12;
      if (dPc === 0) good++;
      else pcErr++;
    }
    let jump = 0;
    for (let i = 1; i < midis.length; i++) jump += Math.abs(midis[i] - midis[i - 1]);
    return { frames, good, pcErr, jump: midis.length > 1 ? jump / (midis.length - 1) : 0 };
  }

  const cases: [string, number, object][] = [
    ["A3 with vibrato + noise", 220, { vibratoCents: 50, noise: 0.08 }],
    ["C3 low male voice", 130.81, { vibratoCents: 40, noise: 0.05 }],
    ["A3 strong 2nd harmonic", 220, { harmonics: [0.5, 1.0, 0.4, 0.2], vibratoCents: 30 }],
    ["A3 weak fundamental", 220, { harmonics: [0.2, 1.0, 0.6, 0.3], vibratoCents: 30 }],
  ];

  for (const [name, hz, opts] of cases) {
    test(`${name}: right pitch-class on ~all frames, low jitter`, () => {
      const r = analyse(voice(hz, 0.5, opts), hzToMidi(hz));
      expect(r.good).toBeGreaterThan(r.frames * 0.9); // ≥90% of frames on the right note
      expect(r.pcErr).toBe(0); // no wrong-pitch-class frames
      expect(r.jump).toBeLessThan(0.5); // frame-to-frame wobble under half a semitone
    });
  }
});
