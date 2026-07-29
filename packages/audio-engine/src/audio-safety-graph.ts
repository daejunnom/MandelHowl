import type { AudioSafetySpec } from "../../contracts/src";

export interface AudioSafetyChain {
  readonly inputMix: GainNode;
  readonly dcBlocker: BiquadFilterNode;
  readonly highPass: BiquadFilterNode;
  readonly lowPass: BiquadFilterNode;
  readonly softClipper: WaveShaperNode;
  readonly rmsLimiter: DynamicsCompressorNode;
  readonly lookAhead: DelayNode;
  readonly peakLimiter: DynamicsCompressorNode;
  readonly masterGain: GainNode;
  readonly analyser: AnalyserNode;
}

function createSoftClipCurve(
  drive: number,
): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(4_096);
  const normalization = Math.tanh(Math.max(1, drive));
  for (let index = 0; index < curve.length; index += 1) {
    const input = (index / (curve.length - 1)) * 2 - 1;
    curve[index] = Math.tanh(input * drive) / normalization;
  }
  return curve;
}

function analyserSizeForWindow(
  sampleRate: number,
  seconds: number,
): number {
  const desired = Math.max(32, sampleRate * seconds);
  let size = 32;
  while (size < desired && size < 32_768) size *= 2;
  return size;
}

/**
 * Constructs the one canonical post-source safety chain used by both the live
 * monitor and the browser-native OfflineAudioContext verification sweep.
 */
export function createAudioSafetyChain(
  context: BaseAudioContext,
  safety: Readonly<AudioSafetySpec>,
): AudioSafetyChain {
  const inputMix = context.createGain();
  inputMix.gain.value = 0.72;

  const dcBlocker = context.createBiquadFilter();
  dcBlocker.type = "highpass";
  dcBlocker.frequency.value = 10;
  dcBlocker.Q.value = 0.5;

  const highPass = context.createBiquadFilter();
  highPass.type = "highpass";
  highPass.frequency.value = safety.bandLimiter.highPassHz;
  highPass.Q.value = safety.bandLimiter.q;

  const lowPass = context.createBiquadFilter();
  lowPass.type = "lowpass";
  lowPass.frequency.value = safety.bandLimiter.lowPassHz;
  lowPass.Q.value = safety.bandLimiter.q;

  const softClipper = context.createWaveShaper();
  softClipper.curve = createSoftClipCurve(safety.softClipper.drive);
  softClipper.oversample = "4x";

  const rmsLimiter = context.createDynamicsCompressor();
  rmsLimiter.threshold.value = safety.rmsLimiter.maximumRmsDbfs;
  rmsLimiter.knee.value = 12;
  rmsLimiter.ratio.value = 8;
  rmsLimiter.attack.value = safety.rmsLimiter.attackSeconds;
  rmsLimiter.release.value = safety.rmsLimiter.releaseSeconds;

  const lookAhead = context.createDelay(0.05);
  lookAhead.delayTime.value = safety.peakLimiter.lookAheadSeconds;

  const peakLimiter = context.createDynamicsCompressor();
  peakLimiter.threshold.value = safety.peakLimiter.ceilingDbfs;
  peakLimiter.knee.value = 0;
  peakLimiter.ratio.value = 20;
  peakLimiter.attack.value = Math.max(
    0.001,
    safety.peakLimiter.lookAheadSeconds,
  );
  peakLimiter.release.value = safety.peakLimiter.releaseSeconds;

  const masterGain = context.createGain();
  masterGain.gain.value = 0;

  const analyser = context.createAnalyser();
  analyser.fftSize = analyserSizeForWindow(
    context.sampleRate,
    safety.rmsLimiter.windowSeconds,
  );
  analyser.smoothingTimeConstant = 0;

  inputMix.connect(dcBlocker);
  dcBlocker.connect(highPass);
  highPass.connect(lowPass);
  lowPass.connect(softClipper);
  softClipper.connect(rmsLimiter);
  rmsLimiter.connect(lookAhead);
  lookAhead.connect(peakLimiter);
  peakLimiter.connect(masterGain);
  masterGain.connect(analyser);
  analyser.connect(context.destination);

  return Object.freeze({
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
  });
}
