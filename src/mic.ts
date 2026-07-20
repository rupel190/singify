/**
 * mic.ts — microphone → pitch adapter (browser-only, not unit-tested).
 *
 * The single untestable slice of the pitch pipeline: it needs a real mic and a
 * live AudioContext. It wraps getUserMedia + an AnalyserNode and exposes a pull
 * API — read() returns the current pitch (call it from your rAF loop), stop()
 * releases the mic. All the actual analysis is the pure, tested detectPitch().
 *
 * AudioContext must be created after a user gesture (autoplay policy), so call
 * startMicPitch() from a click / keypress handler, never on load.
 */

import { detectPitch, rms, type PitchReading, type DetectOptions } from "./pitch";

/** Detection options adjustable live (everything except the fixed FFT size). */
export type LiveDetectOptions = Partial<Omit<DetectOptions, "sampleRate">>;

/** The browser-side audio processing actually in effect (from getSettings()). */
export interface AppliedProcessing {
  autoGainControl?: boolean;
  noiseSuppression?: boolean;
  echoCancellation?: boolean;
}

export interface MicPitch {
  /** Current pitch reading, or null (silence / no confident pitch). */
  read(): PitchReading | null;
  /** Current RMS input level (0..~1) — for a live meter, independent of the gate. */
  level(): number;
  /** Live-adjust detection thresholds (e.g. rmsThreshold for mic sensitivity). */
  setOptions(opts: LiveDetectOptions): void;
  /**
   * What the browser ACTUALLY applied for the three DSP stages — which can
   * differ from what we requested (the constraints are advisory). Any of these
   * being on can fade a held note; this is how you find out which.
   */
  applied: AppliedProcessing;
  /** Release the mic and close the audio graph. */
  stop(): void;
  /** The AudioContext sample rate (usually 44100 or 48000). */
  sampleRate: number;
}

export interface MicPitchOptions extends Omit<DetectOptions, "sampleRate"> {
  /** AnalyserNode window size (power of two). Larger = steadier, more latency. */
  fftSize?: number;
  /** Cancel speaker echo (default true). */
  echoCancellation?: boolean;
  /** Suppress background noise (default true) — but can also duck held notes. */
  noiseSuppression?: boolean;
  /** Auto gain control (default false) — pumps the level, smears pitch. */
  autoGainControl?: boolean;
}

export async function startMicPitch(opts: MicPitchOptions = {}): Promise<MicPitch> {
  const {
    fftSize = 2048,
    echoCancellation = true,
    noiseSuppression = true,
    autoGainControl = false,
    ...detectOpts
  } = opts;

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation, noiseSuppression, autoGainControl },
  });

  // Read back what the browser actually granted — constraints are advisory, so
  // e.g. autoGainControl may still be on despite requesting false.
  const track = stream.getAudioTracks()[0];
  const s = (track?.getSettings() ?? {}) as AppliedProcessing;
  const applied: AppliedProcessing = {
    autoGainControl: s.autoGainControl,
    noiseSuppression: s.noiseSuppression,
    echoCancellation: s.echoCancellation,
  };

  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = fftSize;
  // source → analyser ONLY. Never connect to ctx.destination, or the mic loops
  // back out the speakers.
  source.connect(analyser);

  const buf = new Float32Array(analyser.fftSize);
  let stopped = false;
  // Detection options that can be tuned live (mic sensitivity = rmsThreshold).
  let liveOpts: LiveDetectOptions = { ...detectOpts };

  return {
    sampleRate: ctx.sampleRate,
    applied,
    read() {
      if (stopped) return null;
      analyser.getFloatTimeDomainData(buf);
      return detectPitch(buf, { sampleRate: ctx.sampleRate, ...liveOpts });
    },
    level() {
      if (stopped) return 0;
      analyser.getFloatTimeDomainData(buf);
      return rms(buf);
    },
    setOptions(opts: LiveDetectOptions) {
      liveOpts = { ...liveOpts, ...opts };
    },
    stop() {
      if (stopped) return;
      stopped = true;
      source.disconnect();
      for (const t of stream.getTracks()) t.stop();
      void ctx.close();
    },
  };
}
