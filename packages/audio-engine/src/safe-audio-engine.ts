export interface AudibleSnapshot {
  frequency: number;
  feedbackEnvelope: number;
  activeMode: number;
  regime: "decaying" | "critical" | "growing" | "saturated";
}

const MAX_AUDIBLE_GAIN = 0.045;
const MIN_FREQUENCY = 42;
const MAX_FREQUENCY = 2_400;

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    return minimum;
  }

  return Math.min(maximum, Math.max(minimum, value));
}

function setParam(
  parameter: AudioParam,
  value: number,
  context: BaseAudioContext,
  smoothingSeconds = 0.045,
): void {
  const safeValue = Number.isFinite(value) ? value : 0;
  parameter.cancelScheduledValues(context.currentTime);
  parameter.setTargetAtTime(
    safeValue,
    context.currentTime,
    smoothingSeconds,
  );
}

/**
 * Converts the virtual experiment state into a deliberately quiet Web Audio
 * graph. The virtual 0..100 result never enters this class: only a normalized
 * physical envelope is accepted and independently capped for listening.
 */
export class SafeAudioEngine {
  private context: AudioContext | null = null;
  private oscillators: OscillatorNode[] = [];
  private oscillatorGains: GainNode[] = [];
  private colourFilter: BiquadFilterNode | null = null;
  private masterGain: GainNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private activated = false;

  get isActivated(): boolean {
    return this.activated && this.context?.state === "running";
  }

  async activate(): Promise<boolean> {
    if (typeof window === "undefined") {
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
        return false;
      }

      this.createGraph(new AudioContextConstructor());
    }

    if (!this.context) {
      return false;
    }

    if (this.context.state === "suspended") {
      await this.context.resume();
    }

    this.activated = this.context.state === "running";
    return this.activated;
  }

  applySnapshot(snapshot: AudibleSnapshot): void {
    const context = this.context;
    const masterGain = this.masterGain;
    const colourFilter = this.colourFilter;

    if (!context || !masterGain || !colourFilter) {
      return;
    }

    const baseFrequency = clamp(
      snapshot.frequency,
      MIN_FREQUENCY,
      MAX_FREQUENCY,
    );
    const envelope = clamp(snapshot.feedbackEnvelope, 0, 1);
    const partialRatios = [1, 1.498 + (snapshot.activeMode % 3) * 0.006, 2.01];
    const partialWeights = [0.62, 0.25, 0.13];

    this.oscillators.forEach((oscillator, index) => {
      setParam(
        oscillator.frequency,
        clamp(
          baseFrequency * partialRatios[index],
          MIN_FREQUENCY,
          MAX_FREQUENCY,
        ),
        context,
        0.025,
      );

      const oscillatorGain = this.oscillatorGains[index];
      if (oscillatorGain) {
        setParam(
          oscillatorGain.gain,
          envelope * partialWeights[index],
          context,
          snapshot.regime === "saturated" ? 0.08 : 0.035,
        );
      }
    });

    const audibleCurve = Math.pow(envelope, 1.45);
    const regimeTrim = snapshot.regime === "saturated" ? 0.82 : 1;
    setParam(
      masterGain.gain,
      Math.min(MAX_AUDIBLE_GAIN, audibleCurve * MAX_AUDIBLE_GAIN * regimeTrim),
      context,
      0.06,
    );

    setParam(
      colourFilter.frequency,
      clamp(baseFrequency * 2.8, 260, 4_800),
      context,
      0.08,
    );
  }

  async suspend(): Promise<void> {
    if (!this.context) {
      return;
    }

    if (this.masterGain) {
      setParam(this.masterGain.gain, 0, this.context, 0.012);
    }

    if (this.context.state === "running") {
      await this.context.suspend();
    }

    this.activated = false;
  }

  async dispose(): Promise<void> {
    const context = this.context;
    if (!context) {
      return;
    }

    if (this.masterGain) {
      this.masterGain.gain.cancelScheduledValues(context.currentTime);
      this.masterGain.gain.setValueAtTime(0, context.currentTime);
    }

    for (const oscillator of this.oscillators) {
      try {
        oscillator.stop();
      } catch {
        // An oscillator may already be stopped while a page is being torn down.
      }
      oscillator.disconnect();
    }

    this.oscillatorGains.forEach((node) => node.disconnect());
    this.colourFilter?.disconnect();
    this.compressor?.disconnect();
    this.masterGain?.disconnect();

    if (context.state !== "closed") {
      await context.close();
    }

    this.context = null;
    this.oscillators = [];
    this.oscillatorGains = [];
    this.colourFilter = null;
    this.compressor = null;
    this.masterGain = null;
    this.activated = false;
  }

  private createGraph(context: AudioContext): void {
    const colourFilter = context.createBiquadFilter();
    colourFilter.type = "lowpass";
    colourFilter.frequency.value = 1_800;
    colourFilter.Q.value = 0.7;

    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -24;
    compressor.knee.value = 18;
    compressor.ratio.value = 14;
    compressor.attack.value = 0.004;
    compressor.release.value = 0.22;

    const masterGain = context.createGain();
    masterGain.gain.value = 0;

    colourFilter.connect(compressor);
    compressor.connect(masterGain);
    masterGain.connect(context.destination);

    const oscillatorTypes: OscillatorType[] = ["sine", "triangle", "sine"];
    for (let index = 0; index < oscillatorTypes.length; index += 1) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = oscillatorTypes[index];
      oscillator.frequency.value = 110 * (index + 1);
      gain.gain.value = 0;
      oscillator.connect(gain);
      gain.connect(colourFilter);
      oscillator.start();
      this.oscillators.push(oscillator);
      this.oscillatorGains.push(gain);
    }

    this.context = context;
    this.colourFilter = colourFilter;
    this.compressor = compressor;
    this.masterGain = masterGain;
  }
}
