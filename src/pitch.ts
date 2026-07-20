/**
 * pitch.ts — monophonic pitch detection (pure, unit-tested).
 *
 * detectPitch() takes a window of time-domain audio samples (mono, roughly
 * -1..1) and returns the fundamental frequency, its MIDI note, and a clarity
 * confidence — or null when there's no confident pitch (silence / noise).
 *
 * Method: normalized autocorrelation (ACF with an NSDF-style clarity term).
 * It's cheap, robust enough for a single voice, and — crucially — pure, so it
 * gets real tests. The mic-capture glue (getUserMedia → AnalyserNode) is a thin
 * separate adapter; only *that* is untestable, not this.
 *
 * Scoring is octave-agnostic (see pitchClass): a common autocorrelation failure
 * is the octave error (locking onto a harmonic), and comparing `pitch mod 12`
 * makes the score robust to exactly that.
 */

export const A4_HZ = 440;

export interface PitchReading {
  /** Estimated fundamental frequency in Hz. */
  hz: number;
  /** Fractional MIDI note number (69 = A4). */
  midi: number;
  /** Confidence in [0, 1]; ~1 for a clean periodic tone. */
  clarity: number;
}

/** Frequency (Hz) → fractional MIDI note number. */
export function hzToMidi(hz: number): number {
  return 69 + 12 * Math.log2(hz / A4_HZ);
}

/** MIDI note number → frequency (Hz). */
export function midiToHz(midi: number): number {
  return A4_HZ * 2 ** ((midi - 69) / 12);
}

/** Pitch class 0..11 (C=0) for a MIDI note — octave-agnostic. */
export function pitchClass(midi: number): number {
  return (((Math.round(midi) % 12) + 12) % 12);
}

/**
 * Shift `midi` by whole octaves to land within (or nearest to) the octave
 * centred on [lo, hi]. Preserves pitch class. Lets a sung pitch be shown next
 * to a chart's notes regardless of the singer's octave — and works whatever
 * constant (×12) offset the chart's pitch numbers use vs. MIDI, since the fold
 * is modulo 12.
 */
export function foldToOctaveOf(midi: number, lo: number, hi: number): number {
  const center = (lo + hi) / 2;
  let m = midi;
  while (m - center > 6) m -= 12;
  while (center - m > 6) m += 12;
  return m;
}

export interface PitchSmoother {
  /**
   * Feed one raw per-frame reading (MIDI or null); returns the smoothed value
   * to *display* (or null). This is for the marker only — never feed the score
   * keeper from here; scoring must see the raw, unsmoothed pitch.
   */
  push(midi: number | null): number | null;
  reset(): void;
}

/**
 * Marker smoother: a short median (rejects single-frame octave errors — the
 * dominant flicker in autocorrelation) followed by a light EMA (irons out the
 * rest). Kept small so the added latency stays perceptually negligible. Brief
 * unvoiced gaps (consonants) hold the last value for `holdFrames` frames rather
 * than blinking the marker off.
 */
export function createPitchSmoother(
  opts: { window?: number; alpha?: number; holdFrames?: number } = {}
): PitchSmoother {
  const window = Math.max(1, opts.window ?? 3);
  const alpha = opts.alpha ?? 0.5;
  const holdFrames = opts.holdFrames ?? 3;

  const buf: number[] = [];
  let ema: number | null = null;
  let nullRun = 0;

  const median = (): number => {
    const s = [...buf].sort((a, b) => a - b);
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  };

  return {
    push(midi: number | null): number | null {
      if (midi == null) {
        nullRun++;
        if (nullRun > holdFrames) {
          buf.length = 0;
          ema = null;
          return null;
        }
        return ema; // brief dropout — hold the last smoothed value
      }
      nullRun = 0;
      buf.push(midi);
      if (buf.length > window) buf.shift();
      const med = median();
      ema = ema == null ? med : alpha * med + (1 - alpha) * ema;
      return ema;
    },
    reset(): void {
      buf.length = 0;
      ema = null;
      nullRun = 0;
    },
  };
}

/**
 * Turn a raw detected pitch into the marker to plot against a target note.
 *
 * ORDER MATTERS: fold the raw pitch into the target's octave FIRST, then smooth.
 * If you smooth the absolute pitch first, a detector that flickers between a
 * note and its octave (57↔45) gets averaged into a meaningless in-between value
 * (~51) that then folds wrong — the smoother manufactures jitter. Folding first
 * collapses the octave flicker to one value, so the smoother sees a steady
 * signal. On a hit (within `tolerance` semitones) the marker snaps to the target.
 *
 * `smoother` is advanced exactly once per call — call this once per frame.
 */
export function foldSmoothHit(
  smoother: PitchSmoother,
  rawMidi: number | null,
  targetPitch: number | null,
  tolerance: number
): { pitch: number | null; hit: boolean } {
  let smoothed: number | null;
  if (rawMidi == null || targetPitch == null) {
    smoothed = smoother.push(null); // brief dropout → held value (or null)
  } else {
    smoothed = smoother.push(foldToOctaveOf(rawMidi, targetPitch, targetPitch));
  }
  if (smoothed == null || targetPitch == null) return { pitch: smoothed, hit: false };
  const hit = Math.abs(smoothed - targetPitch) <= tolerance;
  return { pitch: hit ? targetPitch : smoothed, hit };
}

export interface DetectOptions {
  sampleRate: number;
  /** Lowest frequency to consider (default 70 Hz, ~C#2). */
  minHz?: number;
  /** Highest frequency to consider (default 1100 Hz, ~C#6). */
  maxHz?: number;
  /** Below this RMS the window is treated as silence (default 0.01). */
  rmsThreshold?: number;
  /** Below this clarity there's no confident pitch (default 0.9). */
  clarityThreshold?: number;
}

/**
 * Detect the fundamental frequency of a window of samples, or null if there
 * isn't a confident one.
 */
export function detectPitch(
  samples: Float32Array,
  opts: DetectOptions
): PitchReading | null {
  const {
    sampleRate,
    minHz = 70,
    maxHz = 1100,
    rmsThreshold = 0.01,
    clarityThreshold = 0.9,
  } = opts;

  const n = samples.length;
  if (n < 2) return null;

  // 1. Energy gate — skip silence before doing any work.
  let rms = 0;
  for (let i = 0; i < n; i++) rms += samples[i] * samples[i];
  rms = Math.sqrt(rms / n);
  if (rms < rmsThreshold) return null;

  // 2. Autocorrelation c[lag] = Σ samples[i]·samples[i+lag].
  const c = new Float32Array(n);
  for (let lag = 0; lag < n; lag++) {
    let sum = 0;
    for (let i = 0; i < n - lag; i++) sum += samples[i] * samples[i + lag];
    c[lag] = sum;
  }

  // 3. Walk past the initial descent (the main lobe around lag 0) so we don't
  //    mistake the zero-lag energy peak for the pitch period.
  let d = 0;
  while (d < n - 1 && c[d] > c[d + 1]) d++;

  // 4. Peak-pick within the frequency band of interest.
  const minLag = Math.max(1, Math.floor(sampleRate / maxHz));
  const maxLag = Math.min(n - 1, Math.floor(sampleRate / minHz));
  let bestLag = -1;
  let bestVal = -Infinity;
  for (let lag = Math.max(d, minLag); lag <= maxLag; lag++) {
    if (c[lag] > bestVal) {
      bestVal = c[lag];
      bestLag = lag;
    }
  }
  if (bestLag <= 0) return null;

  // 5. Parabolic interpolation around the peak for sub-sample period accuracy.
  const x0 = c[bestLag - 1];
  const x1 = c[bestLag];
  const x2 = bestLag + 1 < n ? c[bestLag + 1] : c[bestLag];
  const denom = x0 + x2 - 2 * x1;
  const shift = denom !== 0 ? (0.5 * (x0 - x2)) / denom : 0;
  const period = bestLag + shift;
  if (period <= 0) return null;

  const hz = sampleRate / period;
  if (hz < minHz || hz > maxHz) return null;

  // 6. NSDF-style clarity: 2·c[lag] / (energy in the two overlapping windows).
  //    Stays ~1 for a clean tone regardless of the lag, unlike raw c[lag]/c[0].
  let m = 0;
  for (let i = 0; i < n - bestLag; i++) {
    m += samples[i] * samples[i] + samples[i + bestLag] * samples[i + bestLag];
  }
  const clarity = m > 0 ? (2 * bestVal) / m : 0;
  if (clarity < clarityThreshold) return null;

  return { hz, midi: hzToMidi(hz), clarity: Math.min(1, Math.max(0, clarity)) };
}
