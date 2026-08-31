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
   * Monitoring — hear this mic out a speaker/headphone while singing. The tap is
   * pre-scoring-gain, so monitor level and scoring gain move independently. Off
   * by default (feedback + latency; see MicPitchOptions.monitor).
   */
  setMonitor(on: boolean): void;
  /** Monitor loudness, 0..1 (0 = silent). Independent of the scoring gain. */
  setMonitorGain(gain: number): void;
  /**
   * Route the monitor to a specific OUTPUT device (a deviceId from
   * enumerateOutputs()); undefined = the system default. Resolves once the sink
   * has switched (via AudioContext.setSinkId). A no-op beyond the default when the
   * engine lacks it (see outputRoutingSupported()).
   */
  setOutputDevice(deviceId: string | undefined): Promise<void>;
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
  /**
   * Start with monitoring on (default FALSE). Monitoring plays this mic back out
   * an output device so the singer hears themselves. It routes straight through
   * the AudioContext output (no media-element buffer), so the delay is just the
   * context's output buffer — roughly 10–30 ms — rather than the ~30–100 ms of a
   * media-element path. Still off by default: even that can read as slapback, and
   * mic + speakers in one room is a feedback path. Best with headphones, or a
   * hardware direct-monitor knob (the true zero-latency option).
   */
  monitor?: boolean;
  /** Initial monitor loudness, 0..1 (default 0.05 — quiet; feedback-safe). Independent of `gain`. */
  monitorGain?: number;
  /**
   * Initial monitor OUTPUT device (a deviceId from enumerateOutputs()); omitted
   * = the system default. Ignored beyond the default when the engine can't route
   * (see outputRoutingSupported()).
   */
  outputDeviceId?: string;
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
    monitor = false,
    monitorGain = 0.05,
    outputDeviceId,
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

  const ctx = new AudioContext({ latencyHint: "interactive" }); // lowest output buffer
  const source = ctx.createMediaStreamSource(stream);
  const gainNode = ctx.createGain();
  gainNode.gain.value = Math.max(0, gain);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = fftSize;
  // Scoring path: source → gain → analyser ONLY. The analyser never reaches
  // ctx.destination, so scoring alone is silent — monitoring is a SEPARATE tap
  // added below, which is the only thing that ever makes sound.
  source.connect(gainNode);
  gainNode.connect(analyser);

  let stopped = false;

  // ── Monitor tap (opt-in) ───────────────────────────────────────────────────
  // A second branch off `source` — BEFORE the scoring gain — so monitor loudness
  // and scoring level are independent knobs. It goes STRAIGHT to the context
  // output (ctx.destination); a chosen output device is selected with
  // AudioContext.setSinkId. This deliberately avoids the older
  // MediaStreamDestination → hidden <audio> path, whose media-element jitter
  // buffer was the bulk of the monitor latency. The scoring path never reaches
  // ctx.destination, so the monitor is still the only thing that makes sound.
  // Built lazily the first time monitoring is switched on, then reused.
  let monitorNode: GainNode | null = null;
  let monOn = monitor;
  let monLevel = clamp01(monitorGain);
  let outId = outputDeviceId;

  const applyMonitorGain = () => {
    if (monitorNode) monitorNode.gain.value = monOn ? monLevel : 0;
  };

  const ensureMonitorChain = () => {
    if (monitorNode || stopped) return;
    monitorNode = ctx.createGain();
    applyMonitorGain();
    source.connect(monitorNode); // tap pre-scoring-gain
    monitorNode.connect(ctx.destination); // straight to output — no media-element re-buffer
    void routeSink();
  };

  // Route the whole context (its only output IS the monitor) to a chosen device.
  const routeSink = async (): Promise<void> => {
    const c = ctx as unknown as { setSinkId?: (id: string) => Promise<void> };
    if (typeof c.setSinkId !== "function") return; // can't pick a device — stays on default
    try {
      await c.setSinkId(outId ?? "");
    } catch (err) {
      console.error("[singify] monitor setSinkId failed:", err);
    }
  };

  if (monOn) ensureMonitorChain();

  const buf = new Float32Array(analyser.fftSize);
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
    setMonitor(on: boolean) {
      monOn = on;
      if (on) ensureMonitorChain();
      applyMonitorGain();
    },
    setMonitorGain(g: number) {
      monLevel = clamp01(g);
      applyMonitorGain();
    },
    async setOutputDevice(id: string | undefined) {
      outId = id;
      ensureMonitorChain(); // a device pick implies wanting to hear it
      await routeSink();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      source.disconnect();
      gainNode.disconnect();
      if (monitorNode) monitorNode.disconnect();
      for (const t of stream.getTracks()) t.stop();
      void ctx.close();
    },
  };
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/**
 * Whether this engine can route the monitor to a chosen output device. When
 * false, monitoring still works but only out the system default — the UI should
 * hide the per-player output picker.
 */
export function outputRoutingSupported(): boolean {
  return (
    typeof AudioContext !== "undefined" &&
    typeof (AudioContext.prototype as unknown as { setSinkId?: unknown }).setSinkId === "function"
  );
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

/** One selectable audio OUTPUT device, for the per-player monitor picker. */
export interface AudioOutput {
  deviceId: string;
  label: string;
}

/**
 * List available audio OUTPUT devices for the per-player monitor picker. Same
 * label-privacy rule as enumerateInputs (call after a mic grant). The deviceIds
 * returned here are what MicPitch.setOutputDevice / setSinkId accept. Returns []
 * when the API is unavailable; an engine with no setSinkId (outputRoutingSupported()
 * === false) can still monitor, just only out the system default.
 */
export async function enumerateOutputs(): Promise<AudioOutput[]> {
  const md = navigator.mediaDevices;
  if (!md?.enumerateDevices) return [];
  try {
    const devices = await md.enumerateDevices();
    return devices
      .filter((d) => d.kind === "audiooutput")
      .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Output ${i + 1}` }));
  } catch (err) {
    console.error("[singify] enumerateOutputs failed:", err);
    return [];
  }
}
