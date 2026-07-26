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
  /** Live-adjust input gain — a per-mic "level" knob (see MicPitchOptions.gain). */
  setGain(gain: number): void;
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
  /**
   * Cancel speaker echo (default false). Off because karaoke wants the raw
   * voice; may be worth enabling later to reduce backing-track bleed when the
   * user is on speakers rather than headphones (a Spotify-phase question).
   */
  echoCancellation?: boolean;
  /**
   * Suppress background noise (default FALSE). Noise suppressors treat a
   * sustained, stationary tone as noise and duck it — they fade held notes,
   * which is exactly what pitch tracking must not lose. Off for singing.
   */
  noiseSuppression?: boolean;
  /** Auto gain control (default false) — pumps the level, smears pitch. */
  autoGainControl?: boolean;
  /**
   * Capture from a specific input device (a deviceId from enumerateInputs());
   * omitted = the system default mic. The per-player selector for multi-mic —
   * each singer's own device.
   */
  deviceId?: string;
  /**
   * Initial input gain multiplier applied BEFORE analysis (default 1). A per-mic
   * "level" knob: pitch detection is amplitude-normalised, so gain doesn't change
   * the detected note — it scales where the signal sits relative to the energy
   * gate. Turn a hot mic down / a quiet one up so both singers balance into one
   * sensitivity setting.
   */
  gain?: number;
}

export async function startMicPitch(opts: MicPitchOptions = {}): Promise<MicPitch> {
  // Raw capture by default: every browser "enhancement" is tuned for speech and
  // harms singing (see the field docs). Callers can opt back in per constraint.
  const {
    fftSize = 2048,
    echoCancellation = false,
    noiseSuppression = false,
    autoGainControl = false,
    deviceId,
    gain = 1,
    ...detectOpts
  } = opts;

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      echoCancellation,
      noiseSuppression,
      autoGainControl,
    },
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
  const gainNode = ctx.createGain();
  gainNode.gain.value = Math.max(0, gain);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = fftSize;
  // source → gain → analyser ONLY. Never connect to ctx.destination, or the mic
  // loops back out the speakers.
  source.connect(gainNode);
  gainNode.connect(analyser);

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
    setGain(g: number) {
      gainNode.gain.value = Math.max(0, g);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      source.disconnect();
      gainNode.disconnect();
      for (const t of stream.getTracks()) t.stop();
      void ctx.close();
    },
  };
}

/** One selectable audio input, for a per-player mic picker. */
export interface AudioInput {
  deviceId: string;
  label: string;
}

/**
 * List available audio input devices for the per-player mic picker. Browsers
 * withhold device LABELS until the page has been granted mic access at least
 * once (a privacy rule), so call this AFTER a first startMicPitch()/getUserMedia
 * or expect blank labels — hence the "Microphone N" fallback. Duplicate/virtual
 * entries (e.g. "default", "communications") are left in; the caller can dedupe.
 * Returns [] when the API is unavailable (old client / no permission).
 */
export async function enumerateInputs(): Promise<AudioInput[]> {
  const md = navigator.mediaDevices;
  if (!md?.enumerateDevices) return [];
  try {
    const devices = await md.enumerateDevices();
    return devices
      .filter((d) => d.kind === "audioinput")
      .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Microphone ${i + 1}` }));
  } catch (err) {
    console.error("[singify] enumerateInputs failed:", err);
    return [];
  }
}
