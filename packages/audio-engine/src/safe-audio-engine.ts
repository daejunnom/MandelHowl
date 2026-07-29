import {
  GENERATED_AUDIO_SAFETY_SPEC,
  type AudioSafetySpec,
  type DiagnosticRecord,
  type RuntimeSnapshot,
} from "../../contracts/src";
import { createDiagnostic } from "../../diagnostics/src";
import {
  dbToLinear,
  measureAudioSamples,
  outputGainFromEnvelope,
  rateLimitGain,
  updateExposureState,
} from "./audio-safety-math";
import { createAudioSafetyChain } from "./audio-safety-graph";

export interface AudibleSnapshot {
  readonly frequency: number;
  readonly feedbackEnvelope: number;
  readonly activeMode: number;
  readonly regime: RuntimeSnapshot["regime"];
  readonly sequence?: number;
  readonly datasetId?: string;
}

export type AudioLifecycleState =
  | "idle"
  | "running"
  | "fading"
  | "suspended"
  | "disposed"
  | "unavailable";

export interface AudioSafetyTelemetry {
  readonly lifecycle: AudioLifecycleState;
  readonly contextState: AudioContextState | "none";
  readonly rmsDbfs: number;
  readonly peakDbfs: number;
  readonly requestedGain: number;
  readonly appliedGain: number;
  readonly exposureGuardActive: boolean;
  readonly continuousHighFrequencySeconds: number;
  readonly continuousSaturationSeconds: number;
  readonly graphNodeCount: number;
  readonly framesApplied: number;
  readonly lastSequence: number | null;
}

export interface SafeAudioEngineOptions {
  readonly safetySpec?: Readonly<AudioSafetySpec>;
  readonly onDiagnostic?: (diagnostic: DiagnosticRecord) => void;
  readonly onTelemetry?: (telemetry: AudioSafetyTelemetry) => void;
}

export type SafeAudioEngineObservers = Pick<
  SafeAudioEngineOptions,
  "onDiagnostic" | "onTelemetry"
>;

interface NormalizedAudibleFrame {
  readonly frequency: number;
  readonly envelope: number;
  readonly activeMode: number;
  readonly regime: RuntimeSnapshot["regime"];
  readonly sequence: number | null;
  readonly datasetId: string | null;
}

const MIN_AUDIBLE_FREQUENCY = 20;
const MAX_AUDIBLE_FREQUENCY = 8_000;
const SILENCE_FLOOR = 0.000_01;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function setTarget(
  parameter: AudioParam,
  value: number,
  context: BaseAudioContext,
  smoothingSeconds: number,
): void {
  parameter.cancelScheduledValues(context.currentTime);
  parameter.setTargetAtTime(
    Number.isFinite(value) ? value : 0,
    context.currentTime,
    Math.max(0.001, smoothingSeconds),
  );
}

function isRuntimeSnapshot(
  snapshot: RuntimeSnapshot | AudibleSnapshot,
): snapshot is RuntimeSnapshot {
  return "feedback" in snapshot && "dial" in snapshot;
}

function normalizeSnapshot(
  snapshot: RuntimeSnapshot | AudibleSnapshot,
): NormalizedAudibleFrame | null {
  const frequency = isRuntimeSnapshot(snapshot)
    ? snapshot.dial.driveFrequencyHz
    : snapshot.frequency;
  const envelope = isRuntimeSnapshot(snapshot)
    ? snapshot.feedback.envelopeNormalized
    : snapshot.feedbackEnvelope;
  const activeMode = isRuntimeSnapshot(snapshot)
    ? snapshot.modes.reduce(
        (strongest, mode, index, modes) =>
          mode.energyNormalized >
          (modes[strongest]?.energyNormalized ?? Number.NEGATIVE_INFINITY)
            ? index
            : strongest,
        0,
      )
    : snapshot.activeMode;
  const sequence = isRuntimeSnapshot(snapshot)
    ? snapshot.sequence
    : (snapshot.sequence ?? null);
  const datasetId = isRuntimeSnapshot(snapshot)
    ? snapshot.datasetId
    : (snapshot.datasetId ?? null);

  if (
    !Number.isFinite(frequency) ||
    !Number.isFinite(envelope) ||
    !Number.isFinite(activeMode)
  ) {
    return null;
  }

  return {
    frequency: clamp(
      frequency,
      MIN_AUDIBLE_FREQUENCY,
      MAX_AUDIBLE_FREQUENCY,
    ),
    envelope: clamp(envelope, 0, 1),
    activeMode: Math.max(0, Math.floor(activeMode)),
    regime: snapshot.regime,
    sequence,
    datasetId,
  };
}

/**
 * Safe, independently limited listening monitor.
 *
 * `RuntimeSnapshot.volume` is intentionally never read: the audible path is
 * derived only from the normalized physical feedback envelope and remains
 * capped by the generated canonical audio safety spec.
 */
export class SafeAudioEngine {
  private readonly safety: Readonly<AudioSafetySpec>;
  private observers: SafeAudioEngineObservers;
  private context: AudioContext | null = null;
  private oscillators: OscillatorNode[] = [];
  private oscillatorGains: GainNode[] = [];
  private inputMix: GainNode | null = null;
  private dcBlocker: BiquadFilterNode | null = null;
  private highPass: BiquadFilterNode | null = null;
  private lowPass: BiquadFilterNode | null = null;
  private softClipper: WaveShaperNode | null = null;
  private rmsLimiter: DynamicsCompressorNode | null = null;
  private lookAhead: DelayNode | null = null;
  private peakLimiter: DynamicsCompressorNode | null = null;
  private masterGain: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private analyserBuffer: Float32Array<ArrayBuffer> | null = null;
  private lifecycle: AudioLifecycleState = "idle";
  private framesApplied = 0;
  private lastSequence: number | null = null;
  private lastDatasetId: string | null = null;
  private lastFrameContextTime = 0;
  private lastMeterContextTime = 0;
  private highFrequencySeconds = 0;
  private saturationSeconds = 0;
  private requestedGain = 0;
  private appliedGain = 0;
  private measuredRmsDbfs = -120;
  private measuredPeakDbfs = -120;
  private exposureGuardActive = false;
  private lifecycleGeneration = 0;
  private invalidSnapshotReported = false;

  constructor(options: SafeAudioEngineOptions = {}) {
    this.safety = options.safetySpec ?? GENERATED_AUDIO_SAFETY_SPEC;
    this.observers = {
      onDiagnostic: options.onDiagnostic,
      onTelemetry: options.onTelemetry,
    };
  }

  setObservers(observers: SafeAudioEngineObservers): void {
    this.observers = { ...observers };
    this.observers.onTelemetry?.(this.telemetry);
  }

  get isActivated(): boolean {
    return this.lifecycle === "running" && this.context?.state === "running";
  }

  get telemetry(): AudioSafetyTelemetry {
    return Object.freeze({
      lifecycle: this.lifecycle,
      contextState: this.context?.state ?? "none",
      rmsDbfs: this.measuredRmsDbfs,
      peakDbfs: this.measuredPeakDbfs,
      requestedGain: this.requestedGain,
      appliedGain: this.appliedGain,
      exposureGuardActive: this.exposureGuardActive,
      continuousHighFrequencySeconds: this.highFrequencySeconds,
      continuousSaturationSeconds: this.saturationSeconds,
      graphNodeCount: this.graphNodeCount,
      framesApplied: this.framesApplied,
      lastSequence: this.lastSequence,
    });
  }

  get graphNodeCount(): number {
    if (!this.context) return 0;
    return (
      this.oscillators.length +
      this.oscillatorGains.length +
      [
        this.inputMix,
        this.dcBlocker,
        this.highPass,
        this.lowPass,
        this.softClipper,
        this.rmsLimiter,
        this.lookAhead,
        this.peakLimiter,
        this.masterGain,
        this.analyser,
      ].filter(Boolean).length
    );
  }

  async activate(): Promise<boolean> {
    if (
      typeof window === "undefined" ||
      this.lifecycle === "disposed"
    ) {
      return false;
    }

    if (!this.context) {
      const AudioContextConstructor =
        window.AudioContext ??
        (
          window as typeof window & {
            webkitAudioContext?: typeof AudioContext;
          }
        ).webkitAudioContext;
      if (!AudioContextConstructor) {
        this.lifecycle = "unavailable";
        this.reportDiagnostic(
          "MH-CAP-AUDIO-UNAVAILABLE",
          "warning",
          "audio.unavailable",
          "audioContext",
          false,
        );
        return false;
      }
      let attemptedContext: AudioContext | null = null;
      try {
        attemptedContext = new AudioContextConstructor();
        this.createGraph(attemptedContext);
      } catch (error) {
        if (
          attemptedContext &&
          attemptedContext.state !== "closed"
        ) {
          try {
            await attemptedContext.close();
          } catch {
            // The failed graph is already unreachable and remains muted.
          }
        }
        this.lifecycle = "unavailable";
        this.reportDiagnostic(
          "MH-AUDIO-GRAPH-FAILED",
          "warning",
          "audio.graphFailed",
          "reason",
          error instanceof Error ? error.message : "unknown",
        );
        this.emitTelemetry();
        return false;
      }
    }

    const context = this.context;
    if (!context) return false;
    const generation = ++this.lifecycleGeneration;
    if (context.state === "suspended") {
      try {
        await context.resume();
      } catch (error) {
        this.lifecycle = "unavailable";
        this.reportDiagnostic(
          "MH-AUDIO-RESUME-FAILED",
          "warning",
          "audio.resumeFailed",
          "reason",
          error instanceof Error ? error.message : "unknown",
        );
        return false;
      }
    }
    if (generation !== this.lifecycleGeneration) return false;

    this.lifecycle = context.state === "running" ? "running" : "suspended";
    this.lastFrameContextTime = context.currentTime;
    this.emitTelemetry();
    return this.lifecycle === "running";
  }

  applyRuntimeSnapshot(snapshot: RuntimeSnapshot): void {
    this.applySnapshot(snapshot);
  }

  /**
   * Legacy projection support is retained for embedders, while the app uses
   * `applyRuntimeSnapshot` so DOM, renderer and audio receive one object.
   */
  applySnapshot(snapshot: RuntimeSnapshot | AudibleSnapshot): void {
    const frame = normalizeSnapshot(snapshot);
    if (!frame) {
      this.muteInvalidSnapshot();
      return;
    }

    const context = this.context;
    if (
      !context ||
      !this.masterGain ||
      !this.lowPass ||
      this.lifecycle !== "running"
    ) {
      return;
    }

    if (
      frame.sequence !== null &&
      frame.sequence === this.lastSequence &&
      frame.datasetId === this.lastDatasetId
    ) {
      return;
    }

    const now = context.currentTime;
    const elapsed = clamp(now - this.lastFrameContextTime, 0, 0.25);
    this.lastFrameContextTime = now;
    this.lastSequence = frame.sequence;
    this.lastDatasetId = frame.datasetId;
    this.framesApplied += 1;
    this.invalidSnapshotReported = false;

    this.updateExposure(frame, elapsed);
    const partialRatios = [
      1,
      1.498 + (frame.activeMode % 3) * 0.006,
      2.01,
    ];
    const partialWeights = [0.62, 0.25, 0.13];
    this.oscillators.forEach((oscillator, index) => {
      setTarget(
        oscillator.frequency,
        clamp(
          frame.frequency * partialRatios[index],
          MIN_AUDIBLE_FREQUENCY,
          Math.min(MAX_AUDIBLE_FREQUENCY, this.safety.bandLimiter.lowPassHz),
        ),
        context,
        0.025,
      );
      const partialGain = this.oscillatorGains[index];
      if (partialGain) {
        setTarget(
          partialGain.gain,
          frame.envelope * partialWeights[index],
          context,
          frame.regime === "saturated" ? 0.08 : 0.035,
        );
      }
    });

    setTarget(
      this.lowPass.frequency,
      clamp(
        frame.frequency * 3.2,
        Math.max(220, this.safety.bandLimiter.highPassHz * 2),
        this.safety.bandLimiter.lowPassHz,
      ),
      context,
      0.08,
    );

    this.requestedGain = outputGainFromEnvelope(
      frame.envelope,
      frame.regime,
      this.exposureGuardActive,
      this.safety,
    );
    this.measureOutput(now);
    const measuredSafetyTrim = this.measurementSafetyTrim();
    const safeTarget = this.requestedGain * measuredSafetyTrim;
    this.appliedGain = this.scheduleRateLimitedGain(safeTarget, elapsed);
    this.emitTelemetry();
  }

  async suspend(reason: "hidden" | "manual" | "error" = "manual"): Promise<void> {
    const context = this.context;
    if (!context || context.state === "closed") return;

    const generation = ++this.lifecycleGeneration;
    this.lifecycle = "fading";
    const fadeSeconds =
      reason === "hidden"
        ? this.safety.gainSmoothing.hiddenFadeSeconds
        : reason === "error"
          ? this.safety.gainSmoothing.errorFadeSeconds
          : this.safety.gainSmoothing.startupFadeSeconds;
    this.fadeMasterToZero(fadeSeconds);
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, Math.ceil(fadeSeconds * 1000) + 8);
    });
    if (generation !== this.lifecycleGeneration || !this.context) return;
    if (context.state === "running") {
      try {
        await context.suspend();
      } catch {
        // Teardown can race the visibility lifecycle; dispose owns final close.
      }
    }
    if (generation === this.lifecycleGeneration) {
      this.lifecycle = "suspended";
      this.appliedGain = 0;
      this.emitTelemetry();
    }
  }

  async dispose(): Promise<void> {
    if (this.lifecycle === "disposed") return;
    ++this.lifecycleGeneration;
    const context = this.context;
    this.lifecycle = "disposed";
    if (!context) return;

    if (this.masterGain) {
      this.masterGain.gain.cancelScheduledValues(context.currentTime);
      this.masterGain.gain.setValueAtTime(0, context.currentTime);
    }
    for (const oscillator of this.oscillators) {
      try {
        oscillator.stop();
      } catch {
        // Oscillators may already be stopped during page teardown.
      }
      oscillator.disconnect();
    }
    this.oscillatorGains.forEach((node) => node.disconnect());
    [
      this.inputMix,
      this.dcBlocker,
      this.highPass,
      this.lowPass,
      this.softClipper,
      this.rmsLimiter,
      this.lookAhead,
      this.peakLimiter,
      this.masterGain,
      this.analyser,
    ].forEach((node) => node?.disconnect());

    if (context.state !== "closed") {
      try {
        await context.close();
      } catch {
        // Closing is best effort when a browser is discarding the page.
      }
    }

    this.context = null;
    this.oscillators = [];
    this.oscillatorGains = [];
    this.inputMix = null;
    this.dcBlocker = null;
    this.highPass = null;
    this.lowPass = null;
    this.softClipper = null;
    this.rmsLimiter = null;
    this.lookAhead = null;
    this.peakLimiter = null;
    this.masterGain = null;
    this.analyser = null;
    this.analyserBuffer = null;
    this.appliedGain = 0;
    this.emitTelemetry();
  }

  private createGraph(context: AudioContext): void {
    const {
      inputMix,
      dcBlocker,
      highPass,
      lowPass,
      softClipper,
      rmsLimiter,
      lookAhead,
      peakLimiter,
      masterGain,
      analyser,
    } = createAudioSafetyChain(context, this.safety);

    const oscillators: OscillatorNode[] = [];
    const oscillatorGains: GainNode[] = [];
    try {
      const oscillatorTypes: OscillatorType[] = [
        "sine",
        "triangle",
        "sine",
      ];
      oscillatorTypes.forEach((type, index) => {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = type;
        oscillator.frequency.value = 110 * (index + 1);
        gain.gain.value = 0;
        oscillator.connect(gain);
        gain.connect(inputMix);
        oscillator.start();
        oscillators.push(oscillator);
        oscillatorGains.push(gain);
      });
    } catch (error) {
      oscillators.forEach((oscillator) => {
        try {
          oscillator.stop();
        } catch {
          // A source that failed before start has nothing left to stop.
        }
        oscillator.disconnect();
      });
      oscillatorGains.forEach((gain) => gain.disconnect());
      throw error;
    }

    this.context = context;
    this.oscillators = oscillators;
    this.oscillatorGains = oscillatorGains;
    this.inputMix = inputMix;
    this.dcBlocker = dcBlocker;
    this.highPass = highPass;
    this.lowPass = lowPass;
    this.softClipper = softClipper;
    this.rmsLimiter = rmsLimiter;
    this.lookAhead = lookAhead;
    this.peakLimiter = peakLimiter;
    this.masterGain = masterGain;
    this.analyser = analyser;
    this.analyserBuffer = new Float32Array(analyser.fftSize);
    this.lifecycle = context.state === "running" ? "running" : "suspended";
    this.lastFrameContextTime = context.currentTime;

    masterGain.gain.setValueAtTime(0, context.currentTime);
    masterGain.gain.linearRampToValueAtTime(
      SILENCE_FLOOR,
      context.currentTime + this.safety.gainSmoothing.startupFadeSeconds,
    );
  }

  private updateExposure(
    frame: NormalizedAudibleFrame,
    elapsed: number,
  ): void {
    const next = updateExposureState(
      {
        highFrequencySeconds: this.highFrequencySeconds,
        saturationSeconds: this.saturationSeconds,
        active: this.exposureGuardActive,
      },
      frame,
      elapsed,
      this.safety,
    );
    this.highFrequencySeconds = next.highFrequencySeconds;
    this.saturationSeconds = next.saturationSeconds;
    const active = next.active;
    if (active && !this.exposureGuardActive) {
      this.reportDiagnostic(
        "MH-AUDIO-SAFETY-GUARD",
        "warning",
        "audio.exposureGuard",
        "attenuationDb",
        this.safety.exposureGuard.attenuationDb,
      );
    }
    this.exposureGuardActive = active;
  }

  private measureOutput(now: number): void {
    const analyser = this.analyser;
    const buffer = this.analyserBuffer;
    if (
      !analyser ||
      !buffer ||
      now - this.lastMeterContextTime < 0.08
    ) {
      return;
    }
    this.lastMeterContextTime = now;
    analyser.getFloatTimeDomainData(buffer);
    const measurement = measureAudioSamples(buffer);
    this.measuredRmsDbfs = measurement.rmsDbfs;
    this.measuredPeakDbfs = measurement.peakDbfs;
  }

  private measurementSafetyTrim(): number {
    const rmsOver = Math.max(
      0,
      this.measuredRmsDbfs - this.safety.rmsLimiter.maximumRmsDbfs,
    );
    const peakOver = Math.max(
      0,
      this.measuredPeakDbfs - this.safety.peakLimiter.ceilingDbfs,
    );
    return dbToLinear(-Math.max(rmsOver, peakOver));
  }

  private scheduleRateLimitedGain(target: number, elapsed: number): number {
    const context = this.context;
    const masterGain = this.masterGain;
    if (!context || !masterGain) return 0;

    const nextGain = rateLimitGain(
      this.appliedGain,
      target,
      Math.max(elapsed, 1 / 120),
      this.safety.gainSmoothing.maximumChangeDbPerSecond,
      this.safety.sourceMapping.maximumOutputGainLinear,
    );
    setTarget(
      masterGain.gain,
      nextGain,
      context,
      Math.max(0.008, 1 / this.safety.gainSmoothing.maximumChangeDbPerSecond),
    );
    return nextGain;
  }

  private fadeMasterToZero(seconds: number): void {
    const context = this.context;
    const masterGain = this.masterGain;
    if (!context || !masterGain) return;
    const now = context.currentTime;
    masterGain.gain.cancelScheduledValues(now);
    masterGain.gain.setValueAtTime(
      Math.max(0, masterGain.gain.value),
      now,
    );
    masterGain.gain.linearRampToValueAtTime(0, now + Math.max(0.001, seconds));
  }

  private muteInvalidSnapshot(): void {
    const context = this.context;
    if (context && this.masterGain) {
      this.fadeMasterToZero(this.safety.gainSmoothing.errorFadeSeconds);
    }
    this.appliedGain = 0;
    if (!this.invalidSnapshotReported) {
      this.invalidSnapshotReported = true;
      this.reportDiagnostic(
        "MH-AUDIO-INVALID-SNAPSHOT",
        "warning",
        "audio.invalidSnapshot",
        "policy",
        this.safety.lifecycle.invalidNumberPolicy,
      );
    }
  }

  private reportDiagnostic(
    code: string,
    severity: "info" | "warning" | "fatal",
    messageKey: string,
    key: string,
    value: string | number | boolean | null,
  ): void {
    this.observers.onDiagnostic?.(
      createDiagnostic({
        code,
        severity,
        messageKey,
        evidence: [
          {
            key,
            value,
            source: "safe-audio-engine",
          },
        ],
      }),
    );
  }

  private emitTelemetry(): void {
    this.observers.onTelemetry?.(this.telemetry);
  }
}
