import { afterEach, describe, expect, it } from "vitest";
import {
  GENERATED_AUDIO_SAFETY_SPEC,
  type RuntimeSnapshot,
} from "../../contracts/src";
import { SafeAudioEngine } from "./safe-audio-engine";

class FakeAudioParam {
  value = 0;
  readonly targets: number[] = [];
  readonly ramps: { readonly value: number; readonly atTime: number }[] = [];
  throwOnTarget = false;

  cancelScheduledValues(): void {}

  setTargetAtTime(value: number): void {
    if (this.throwOnTarget) {
      throw new Error("synthetic AudioParam runtime failure");
    }
    this.value = value;
    this.targets.push(value);
  }

  setValueAtTime(value: number): void {
    this.value = value;
  }

  linearRampToValueAtTime(value: number, atTime: number): void {
    this.value = value;
    this.ramps.push({ value, atTime });
  }
}

class FakeAudioNode {
  readonly connections: FakeAudioNode[] = [];

  connect<T extends FakeAudioNode>(destination: T): T {
    this.connections.push(destination);
    return destination;
  }

  disconnect(): void {}
}

class FakeGainNode extends FakeAudioNode {
  readonly gain = new FakeAudioParam();
}

class FakeOscillatorNode extends FakeAudioNode {
  readonly frequency = new FakeAudioParam();
  type: OscillatorType = "sine";
  started = false;

  start(): void {
    this.started = true;
  }

  stop(): void {
    this.started = false;
  }
}

class FakeBiquadNode extends FakeAudioNode {
  type: BiquadFilterType = "lowpass";
  readonly frequency = new FakeAudioParam();
  readonly Q = new FakeAudioParam();
}

class FakeWaveShaperNode extends FakeAudioNode {
  curve: Float32Array<ArrayBuffer> | null = null;
  oversample: OverSampleType = "none";
}

class FakeCompressorNode extends FakeAudioNode {
  readonly threshold = new FakeAudioParam();
  readonly knee = new FakeAudioParam();
  readonly ratio = new FakeAudioParam();
  readonly attack = new FakeAudioParam();
  readonly release = new FakeAudioParam();
}

class FakeDelayNode extends FakeAudioNode {
  readonly delayTime = new FakeAudioParam();
}

class FakeAnalyserNode extends FakeAudioNode {
  fftSize = 32;
  smoothingTimeConstant = 0;

  getFloatTimeDomainData(target: Float32Array): void {
    target.fill(0);
  }
}

class FakeAudioContext {
  static latest: FakeAudioContext | null = null;
  static constructionCount = 0;
  static initialState: AudioContextState = "running";
  static resumeBarrier: Promise<void> | null = null;
  static resumeCount = 0;

  readonly sampleRate = 48_000;
  readonly destination = new FakeAudioNode();
  readonly oscillators: FakeOscillatorNode[] = [];
  readonly gains: FakeGainNode[] = [];
  readonly biquads: FakeBiquadNode[] = [];
  readonly waveShapers: FakeWaveShaperNode[] = [];
  readonly compressors: FakeCompressorNode[] = [];
  readonly delays: FakeDelayNode[] = [];
  readonly analysers: FakeAnalyserNode[] = [];
  currentTime = 0;
  state: AudioContextState;

  constructor() {
    FakeAudioContext.constructionCount += 1;
    FakeAudioContext.latest = this;
    this.state = FakeAudioContext.initialState;
  }

  createGain(): GainNode {
    const gain = new FakeGainNode();
    this.gains.push(gain);
    return gain as unknown as GainNode;
  }

  createOscillator(): OscillatorNode {
    const oscillator = new FakeOscillatorNode();
    this.oscillators.push(oscillator);
    return oscillator as unknown as OscillatorNode;
  }

  createBiquadFilter(): BiquadFilterNode {
    const biquad = new FakeBiquadNode();
    this.biquads.push(biquad);
    return biquad as unknown as BiquadFilterNode;
  }

  createWaveShaper(): WaveShaperNode {
    const waveShaper = new FakeWaveShaperNode();
    this.waveShapers.push(waveShaper);
    return waveShaper as unknown as WaveShaperNode;
  }

  createDynamicsCompressor(): DynamicsCompressorNode {
    const compressor = new FakeCompressorNode();
    this.compressors.push(compressor);
    return compressor as unknown as DynamicsCompressorNode;
  }

  createDelay(): DelayNode {
    const delay = new FakeDelayNode();
    this.delays.push(delay);
    return delay as unknown as DelayNode;
  }

  createAnalyser(): AnalyserNode {
    const analyser = new FakeAnalyserNode();
    this.analysers.push(analyser);
    return analyser as unknown as AnalyserNode;
  }

  async resume(): Promise<void> {
    FakeAudioContext.resumeCount += 1;
    await FakeAudioContext.resumeBarrier;
    this.state = "running";
  }

  async suspend(): Promise<void> {
    this.state = "suspended";
  }

  async close(): Promise<void> {
    this.state = "closed";
  }
}

function runtimeSnapshot(sequence = 1): RuntimeSnapshot {
  return {
    schemaVersion: "mandelhowl.runtime-snapshot.v2",
    unitSystem: "SI",
    datasetId: `sha256:${"a".repeat(64)}`,
    sequence,
    simulationStep: sequence,
    simulationTimeSeconds: sequence / 240,
    dial: {
      unwrappedAngleRad: 0,
      angularVelocityRadPerSecond: 0,
      driveFrequencyCentiHz: 22_000,
      previousDriveFrequencyCentiHz: 22_000,
      driveFrequencyHz: 220,
      previousDriveFrequencyHz: 220,
      sweepRateHzPerSecond: 0,
      approachDirection: "stationary",
      stationaryTimeSeconds: 1,
      atMinimumEndStop: false,
      atMaximumEndStop: false,
    },
    modes: [
      {
        modeId: "mode-negative",
        naturalFrequencyHz: 330,
        audibleWeightNormalized: 1,
        amplitudeNormalized: 0.8,
        phaseRad: Math.PI,
        energyNormalized: 0.64,
      },
      {
        modeId: "mode-positive",
        naturalFrequencyHz: 440,
        audibleWeightNormalized: 1,
        amplitudeNormalized: 0.4,
        phaseRad: 0,
        energyNormalized: 0.16,
      },
    ],
    activeModeId: "mode-negative",
    microphone: {
      rmsNormalized: 0.4,
      peakNormalized: 0.6,
      recentSamples: [],
    },
    feedback: {
      envelopeNormalized: 0.8,
      loopSignalNormalized: 0.5,
      limiterGainReductionDb: 1,
      limiterActive: true,
    },
    regime: "saturated",
    volume: {
      status: "settled",
      value: 100,
      lastSettledValue: 100,
      progress: 1,
    },
    diagnostics: [],
  };
}

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "window",
);

afterEach(() => {
  FakeAudioContext.latest = null;
  FakeAudioContext.constructionCount = 0;
  FakeAudioContext.initialState = "running";
  FakeAudioContext.resumeBarrier = null;
  FakeAudioContext.resumeCount = 0;
  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, "window", originalWindowDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, "window");
  }
});

describe("safe modal audio graph", () => {
  it("does not construct AudioContext before an explicit activation gesture", () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        AudioContext: FakeAudioContext,
        setTimeout: globalThis.setTimeout,
      },
    });
    const engine = new SafeAudioEngine();
    engine.applyRuntimeSnapshot(runtimeSnapshot());

    expect(FakeAudioContext.constructionCount).toBe(0);
    expect(engine.telemetry).toMatchObject({
      lifecycle: "idle",
      contextState: "none",
      graphNodeCount: 0,
      appliedGain: 0,
    });
  });

  it("coalesces concurrent activation gestures into one AudioContext resume", async () => {
    let releaseResume = () => {};
    FakeAudioContext.initialState = "suspended";
    FakeAudioContext.resumeBarrier = new Promise<void>((resolve) => {
      releaseResume = resolve;
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        AudioContext: FakeAudioContext,
        setTimeout: globalThis.setTimeout,
      },
    });
    const engine = new SafeAudioEngine();

    const first = engine.activate();
    const concurrent = engine.activate();
    expect(first).toBe(concurrent);
    expect(FakeAudioContext.constructionCount).toBe(1);
    expect(FakeAudioContext.resumeCount).toBe(1);

    releaseResume();
    await expect(Promise.all([first, concurrent])).resolves.toEqual([
      true,
      true,
    ]);
    expect(engine.telemetry.lifecycle).toBe("running");
    await engine.dispose();
  });

  it("cannot resurrect an activation that loses a race with disposal", async () => {
    let releaseResume = () => {};
    FakeAudioContext.initialState = "suspended";
    FakeAudioContext.resumeBarrier = new Promise<void>((resolve) => {
      releaseResume = resolve;
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        AudioContext: FakeAudioContext,
        setTimeout: globalThis.setTimeout,
      },
    });
    const engine = new SafeAudioEngine();

    const activation = engine.activate();
    await engine.dispose();
    releaseResume();

    await expect(activation).resolves.toBe(false);
    expect(engine.telemetry).toMatchObject({
      lifecycle: "disposed",
      contextState: "none",
      graphNodeCount: 0,
      appliedGain: 0,
    });
  });

  it("isolates throwing diagnostic and telemetry observers from the safe graph", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        AudioContext: FakeAudioContext,
        setTimeout: globalThis.setTimeout,
      },
    });
    let diagnosticCalls = 0;
    let telemetryCalls = 0;
    const engine = new SafeAudioEngine();
    expect(() =>
      engine.setObservers({
        onDiagnostic: () => {
          diagnosticCalls += 1;
          throw new Error("synthetic diagnostic observer failure");
        },
        onTelemetry: () => {
          telemetryCalls += 1;
          throw new Error("synthetic telemetry observer failure");
        },
      }),
    ).not.toThrow();
    await expect(engine.activate()).resolves.toBe(true);

    const invalid = {
      ...runtimeSnapshot(),
      feedback: {
        ...runtimeSnapshot().feedback,
        envelopeNormalized: Number.NaN,
      },
    };
    expect(() =>
      engine.applyRuntimeSnapshot(invalid),
    ).not.toThrow();
    expect(engine.telemetry).toMatchObject({
      lifecycle: "running",
      appliedGain: 0,
    });
    expect(diagnosticCalls).toBe(1);
    expect(telemetryCalls).toBeGreaterThanOrEqual(2);
    await expect(engine.dispose()).resolves.toBeUndefined();
  });

  it("applies signed canonical modal frequencies and fails closed", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        AudioContext: FakeAudioContext,
        setTimeout: globalThis.setTimeout,
      },
    });
    const diagnostics: string[] = [];
    const engine = new SafeAudioEngine({
      onDiagnostic: ({ code }) => diagnostics.push(code),
    });
    expect(await engine.activate()).toBe(true);

    const context = FakeAudioContext.latest!;
    context.currentTime = 1 / 60;
    engine.applyRuntimeSnapshot(runtimeSnapshot());

    expect(engine.telemetry.framesApplied).toBe(1);
    expect(context.oscillators).toHaveLength(9);
    expect(context.oscillators[0]?.frequency.value).toBe(220);
    expect(context.oscillators[1]?.frequency.value).toBe(330);
    expect(context.oscillators[2]?.frequency.value).toBe(440);

    const sourceGains = context.oscillators.map(
      (oscillator) => oscillator.connections[0] as FakeGainNode,
    );
    expect(sourceGains[0]?.gain.value).toBeGreaterThan(0);
    expect(sourceGains[1]?.gain.value).toBeLessThan(0);
    expect(sourceGains[2]?.gain.value).toBeGreaterThan(0);
    expect(
      sourceGains.reduce(
        (sum, source) => sum + Math.abs(source.gain.value),
        0,
      ),
    ).toBeCloseTo(0.8, 12);

    context.currentTime += 1 / 60;
    engine.applyRuntimeSnapshot(runtimeSnapshot());
    expect(engine.telemetry.framesApplied).toBe(1);

    engine.applyRuntimeSnapshot({
      ...runtimeSnapshot(2),
      modes: [
        {
          ...runtimeSnapshot(2).modes[0]!,
          naturalFrequencyHz: Number.NaN,
        },
      ],
    });
    expect(engine.telemetry.appliedGain).toBe(0);
    expect(diagnostics).toContain("MH-AUDIO-INVALID-SNAPSHOT");
    await engine.dispose();
  });

  it("connects every source through one limiter chain with no bypass", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        AudioContext: FakeAudioContext,
        setTimeout: globalThis.setTimeout,
      },
    });
    const engine = new SafeAudioEngine();
    expect(await engine.activate()).toBe(true);

    const context = FakeAudioContext.latest!;
    const [inputMix, masterGain, ...sourceGains] = context.gains;
    const [dcBlocker, highPass, lowPass] = context.biquads;
    const [softClipper] = context.waveShapers;
    const [rmsLimiter, peakLimiter] = context.compressors;
    const [lookAhead] = context.delays;
    const [analyser] = context.analysers;

    expect(inputMix?.connections).toEqual([dcBlocker]);
    expect(dcBlocker?.connections).toEqual([highPass]);
    expect(highPass?.connections).toEqual([lowPass]);
    expect(lowPass?.connections).toEqual([softClipper]);
    expect(softClipper?.connections).toEqual([rmsLimiter]);
    expect(rmsLimiter?.connections).toEqual([lookAhead]);
    expect(lookAhead?.connections).toEqual([peakLimiter]);
    expect(peakLimiter?.connections).toEqual([masterGain]);
    expect(masterGain?.connections).toEqual([analyser]);
    expect(analyser?.connections).toEqual([context.destination]);
    expect(sourceGains).toHaveLength(context.oscillators.length);
    for (let index = 0; index < context.oscillators.length; index += 1) {
      expect(context.oscillators[index]?.connections).toEqual([
        sourceGains[index],
      ]);
      expect(sourceGains[index]?.connections).toEqual([inputMix]);
    }
    await engine.dispose();
  });

  it("uses the canonical hidden fade before suspension", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        AudioContext: FakeAudioContext,
        setTimeout: globalThis.setTimeout,
      },
    });
    const engine = new SafeAudioEngine();
    expect(await engine.activate()).toBe(true);
    const context = FakeAudioContext.latest!;
    const masterGain = context.gains[1]!;
    context.currentTime = 3;

    const pending = engine.suspend("hidden");
    expect(engine.telemetry.lifecycle).toBe("fading");
    expect(masterGain.gain.ramps.at(-1)).toEqual({
      value: 0,
      atTime:
        context.currentTime +
        GENERATED_AUDIO_SAFETY_SPEC.gainSmoothing.hiddenFadeSeconds,
    });
    await pending;
    expect(engine.telemetry).toMatchObject({
      lifecycle: "suspended",
      contextState: "suspended",
      appliedGain: 0,
    });
    await engine.dispose();
  });

  it("quarantines and mutes a graph after a runtime AudioContext error", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        AudioContext: FakeAudioContext,
        setTimeout: globalThis.setTimeout,
      },
    });
    const diagnostics: string[] = [];
    const engine = new SafeAudioEngine({
      onDiagnostic: ({ code }) => diagnostics.push(code),
    });
    expect(await engine.activate()).toBe(true);
    const context = FakeAudioContext.latest!;
    const masterGain = context.gains[1]!;
    context.oscillators[0]!.frequency.throwOnTarget = true;
    context.currentTime = 1 / 60;

    expect(() =>
      engine.applyRuntimeSnapshot(runtimeSnapshot()),
    ).not.toThrow();
    expect(masterGain.gain.value).toBe(0);
    expect(engine.telemetry).toMatchObject({
      lifecycle: "unavailable",
      appliedGain: 0,
      requestedGain: 0,
    });
    expect(diagnostics).toContain("MH-AUDIO-RUNTIME-FAILED");
    expect(await engine.activate()).toBe(false);
    expect(engine.telemetry.lifecycle).toBe("unavailable");
    await engine.dispose();
  });
});
