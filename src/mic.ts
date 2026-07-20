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

import { detectPitch, type PitchReading, type DetectOptions } from "./pitch";

export interface MicPitch {
  /** Current pitch reading, or null (silence / no confident pitch). */
  read(): PitchReading | null;
  /** Release the mic and close the audio graph. */
  stop(): void;
  /** The AudioContext sample rate (usually 44100 or 48000). */
  sampleRate: number;
}

export interface MicPitchOptions extends Omit<DetectOptions, "sampleRate"> {
  /** AnalyserNode window size (power of two). Larger = steadier, more latency. */
  fftSize?: number;
}

export async function startMicPitch(opts: MicPitchOptions = {}): Promise<MicPitch> {
  const { fftSize = 2048, ...detectOpts } = opts;

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: false, // AGC pumps the level and smears the pitch
    },
  });

  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = fftSize;
  // source → analyser ONLY. Never connect to ctx.destination, or the mic loops
  // back out the speakers.
  source.connect(analyser);

  const buf = new Float32Array(analyser.fftSize);
  let stopped = false;

  return {
    sampleRate: ctx.sampleRate,
    read() {
      if (stopped) return null;
      analyser.getFloatTimeDomainData(buf);
      return detectPitch(buf, { sampleRate: ctx.sampleRate, ...detectOpts });
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
