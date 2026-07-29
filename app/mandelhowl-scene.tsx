"use client";

import type {
  CSSProperties,
  KeyboardEventHandler,
  PointerEventHandler,
  Ref,
  WheelEventHandler,
} from "react";
import { presentOscilloscope } from "@/packages/presentation-model/src";
import "./mandelhowl.css";

export type MandelHowlRegime =
  | "decaying"
  | "critical"
  | "growing"
  | "saturated";

export interface MandelHowlSceneProps {
  /** Current drive frequency in hertz. */
  frequency: number;
  frequencyMin?: number;
  frequencyMax?: number;
  /** Continuous, unwrapped dial angle in radians. */
  angle: number;
  /** Canonical virtual volume output in the inclusive range 0..100. */
  volume: number;
  regime: MandelHowlRegime;
  /** Normalized loop envelope in the inclusive range 0..1. */
  envelope: number;
  /** Zero-based active mode index, or null while no mode is captured. */
  activeMode: number | null;
  /** Normalized measurement-window progress in the inclusive range 0..1. */
  measurementProgress: number;
  measurementStatus?: "measuring" | "settled";
  microphoneRms?: number;
  microphonePeak?: number;
  microphoneSamples?: readonly number[];
  activeModePhase?: number;
  /** Whether the safe listening graph is enabled. This is display-only here. */
  audioEnabled: boolean;
  rendererKind?: "webgl2" | "canvas2d" | "static";
  renderQuality?: "high" | "balanced" | "reduced" | "canvas";
  datasetStatus?: "loading" | "verified" | "prototype" | "error";
  diagnosticSeverity?: "none" | "info" | "warning" | "fatal";
  diagnosticTitle?: string | null;
  diagnosticMessage?: string | null;
  diagnosticCode?: string | null;
  diagnosticDetail?: string | null;
  challengeTarget?: number | null;
  dragging: boolean;
  onDialPointerDown: PointerEventHandler<HTMLDivElement>;
  onDialPointerMove: PointerEventHandler<HTMLDivElement>;
  onDialPointerUp: PointerEventHandler<HTMLDivElement>;
  onDialPointerCancel: PointerEventHandler<HTMLDivElement>;
  onDialLostPointerCapture?: PointerEventHandler<HTMLDivElement>;
  onDialKeyDown: KeyboardEventHandler<HTMLDivElement>;
  onDialWheel: WheelEventHandler<HTMLDivElement>;
  /** The parent owns all canvas drawing and its animation lifecycle. */
  canvasRef: Ref<HTMLCanvasElement>;
}

type SceneStyle = CSSProperties & {
  "--dial-angle": string;
  "--envelope": number;
  "--measurement": string;
  "--volume": number;
  "--phase-angle": string;
  "--target-volume": number;
};

const REGIME_COPY: Record<
  MandelHowlRegime,
  { label: string; description: string }
> = {
  decaying: {
    label: "DECAYING",
    description: "Loop below threshold",
  },
  critical: {
    label: "CRITICAL",
    description: "Burst boundary",
  },
  growing: {
    label: "GROWING",
    description: "Feedback capture",
  },
  saturated: {
    label: "LIMITING",
    description: "Virtual ceiling",
  },
};

function clampUnit(value: number) {
  return Math.min(1, Math.max(0, value));
}

function formatFrequency(frequency: number) {
  if (frequency >= 1000) {
    const precision = frequency < 10000 ? 2 : 1;
    return `${(frequency / 1000).toFixed(precision)} kHz`;
  }

  return `${frequency.toFixed(frequency < 100 ? 1 : 0)} Hz`;
}

function formatCompactFrequency(frequency: number) {
  if (frequency >= 1000) {
    return `${Number((frequency / 1000).toPrecision(3))}k`;
  }
  return `${Math.round(frequency)}`;
}

function logarithmicTick(
  minimum: number,
  maximum: number,
  normalized: number,
) {
  return minimum * Math.pow(maximum / minimum, normalized);
}

export function MandelHowlScene({
  frequency,
  frequencyMin = 45,
  frequencyMax = 6_000,
  angle,
  volume,
  regime,
  envelope,
  activeMode,
  measurementProgress,
  measurementStatus = "measuring",
  microphoneRms = 0,
  microphonePeak = 0,
  microphoneSamples = [],
  activeModePhase = 0,
  audioEnabled,
  rendererKind = "canvas2d",
  renderQuality = "canvas",
  datasetStatus = "prototype",
  diagnosticSeverity = "none",
  diagnosticTitle = null,
  diagnosticMessage = null,
  diagnosticCode = null,
  diagnosticDetail = null,
  challengeTarget = null,
  dragging,
  onDialPointerDown,
  onDialPointerMove,
  onDialPointerUp,
  onDialPointerCancel,
  onDialLostPointerCapture,
  onDialKeyDown,
  onDialWheel,
  canvasRef,
}: MandelHowlSceneProps) {
  const progress = clampUnit(measurementProgress);
  const visualEnvelope = clampUnit(envelope);
  const displayedVolume = Math.round(volume).toString().padStart(3, "0");
  const displayedFrequency = formatFrequency(frequency);
  const frequencyTicks = [
    frequencyMin,
    logarithmicTick(frequencyMin, frequencyMax, 1 / 3),
    logarithmicTick(frequencyMin, frequencyMax, 2 / 3),
    frequencyMax,
  ].map(formatCompactFrequency);
  const modeLabel =
    activeMode === null
      ? "NO MODE"
      : `MODE ${String(activeMode + 1).padStart(2, "0")}`;
  const regimeCopy = REGIME_COPY[regime];
  const sceneStyle: SceneStyle = {
    "--dial-angle": `${angle}rad`,
    "--envelope": visualEnvelope,
    "--measurement": `${Math.round(progress * 100)}%`,
    "--volume": volume,
    "--phase-angle": `${activeModePhase}rad`,
    "--target-volume": challengeTarget ?? 0,
  };
  const isVerifiedDataset = datasetStatus === "verified";
  const oscilloscope = presentOscilloscope({
    recentSamples: microphoneSamples,
    rmsNormalized: microphoneRms,
    peakNormalized: microphonePeak,
  });
  const stableAnnouncement =
    measurementStatus === "settled"
      ? `Volume settled at ${displayedVolume} out of 100.`
      : "";

  return (
    <main
      className={`mh-shell mh-regime-${regime}${
        dragging ? " mh-is-dragging" : ""
      } mh-measurement-${measurementStatus}`}
      data-regime={regime}
      style={sceneStyle}
    >
      <header className="mh-header">
        <div className="mh-brand" aria-label="MandelHowl">
          <span className="mh-brand-mark" aria-hidden="true">
            <span />
          </span>
          <div>
            <p className="mh-kicker">Experimental acoustic interface</p>
            <h1>MandelHowl</h1>
          </div>
        </div>

        <div className="mh-header-readouts" aria-label="System status">
          <p>
            <span>DATASET</span>
            {isVerifiedDataset
              ? "VERIFIED THIN-PLATE BAKE"
              : "PROTOTYPE / CENTER CLAMP"}
          </p>
          <p
            className={audioEnabled ? "mh-audio-on" : "mh-audio-off"}
            role="status"
          >
            <span className="mh-status-dot" aria-hidden="true" />
            {audioEnabled ? "SAFE MONITOR ACTIVE" : "MONITOR MUTED"}
          </p>
        </div>
      </header>

      <section className="mh-workbench" aria-label="MandelHowl experiment">
        <section className="mh-drive-panel" aria-labelledby="drive-title">
          <div className="mh-section-heading">
            <span>01 / DRIVE</span>
            <h2 id="drive-title">Frequency input</h2>
          </div>

          <div
            className="mh-dial"
            role="slider"
            tabIndex={0}
            aria-label="Drive frequency"
            aria-valuemin={frequencyMin}
            aria-valuemax={frequencyMax}
            aria-valuenow={Math.round(frequency)}
            aria-valuetext={`${displayedFrequency}, ${regimeCopy.label.toLowerCase()}`}
            aria-orientation="horizontal"
            onPointerDown={onDialPointerDown}
            onPointerMove={onDialPointerMove}
            onPointerUp={onDialPointerUp}
            onPointerCancel={onDialPointerCancel}
            onLostPointerCapture={onDialLostPointerCapture}
            onKeyDown={onDialKeyDown}
            onWheel={onDialWheel}
          >
            <span className="mh-dial-scale" aria-hidden="true" />
            <span className="mh-dial-track" aria-hidden="true" />
            <span className="mh-dial-label mh-dial-label-20" aria-hidden="true">
              {frequencyTicks[0]}
            </span>
            <span className="mh-dial-label mh-dial-label-200" aria-hidden="true">
              {frequencyTicks[1]}
            </span>
            <span className="mh-dial-label mh-dial-label-2k" aria-hidden="true">
              {frequencyTicks[2]}
            </span>
            <span className="mh-dial-label mh-dial-label-20k" aria-hidden="true">
              {frequencyTicks[3]}
            </span>

            <span className="mh-dial-face">
              <span className="mh-dial-type">DRIVE FREQUENCY</span>
              <strong>{displayedFrequency}</strong>
              <span className="mh-dial-hint">
                {dragging ? "SWEEPING" : "DRAG · KEYS · WHEEL"}
              </span>
            </span>

            <span className="mh-dial-pointer" aria-hidden="true">
              <span />
            </span>
          </div>

          <div className="mh-drive-footer" aria-label="Drive state">
            <span>LOG SWEEP</span>
            <span className="mh-drive-direction">
              <i aria-hidden="true">−</i>
              {formatFrequency(frequencyMin)}
              <b aria-hidden="true" />
              {formatFrequency(frequencyMax)}
              <i aria-hidden="true">+</i>
            </span>
          </div>
        </section>

        <section className="mh-apparatus-panel" aria-labelledby="apparatus-title">
          <div className="mh-section-heading mh-section-heading-wide">
            <div>
              <span>02 / RESONATOR</span>
              <h2 id="apparatus-title">Closed-loop Chladni apparatus</h2>
            </div>
            <div className="mh-mode-readout">
              <span>CAPTURE</span>
              <strong>{modeLabel}</strong>
            </div>
          </div>

          <div
            className="mh-apparatus"
            aria-label={`Signal path: speaker drives the ${
              isVerifiedDataset
                ? "verified Mandelbrot-encoded thin-plate bake"
                : "explicitly labelled analytical prototype plate"
            }, microphone returns the response through the feedback loop. ${regimeCopy.label}, ${regimeCopy.description}.`}
          >
            <div className="mh-signal-key mh-signal-key-drive" aria-hidden="true">
              <span>DRIVE</span>
              <i />
            </div>
            <div
              className="mh-signal-key mh-signal-key-return"
              aria-hidden="true"
            >
              <span>RETURN</span>
              <i />
            </div>

            <div className="mh-speaker" aria-hidden="true">
              <span className="mh-speaker-frame">
                <span className="mh-speaker-cone">
                  <i />
                </span>
              </span>
              <strong>SPEAKER</strong>
              <small>EXCITER 01</small>
            </div>

            <div className="mh-drive-waves" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>

            <figure className="mh-plate-assembly">
              <div className="mh-plate-title">
                <span>
                  {isVerifiedDataset
                    ? "MANDELBROT-ENCODED / THIN PLATE"
                    : "ANALYTICAL PROTOTYPE"}
                </span>
                <strong>METAL PLATE + SAND</strong>
              </div>
              <div className="mh-plate-brace" aria-hidden="true">
                <span />
                <span />
                <span />
                <span />
              </div>
              <div className="mh-plate-hardware">
                <div className="mh-plate-surface">
                  <canvas
                    ref={canvasRef}
                    className="mh-plate-canvas"
                    role="img"
                    aria-label={`Animated Chladni sand pattern at ${displayedFrequency}; ${modeLabel.toLowerCase()}`}
                  >
                    Chladni sand pattern visualization at {displayedFrequency}.
                  </canvas>
                  <span className="mh-plate-sheen" aria-hidden="true" />
                  <span className="mh-center-clamp" aria-hidden="true">
                    <i />
                  </span>
                </div>
              </div>
              <figcaption>
                <span>
                  {isVerifiedDataset ? "VERIFIED MODAL DATA" : "DETERMINISTIC PREVIEW"}
                </span>
                <span>
                  {rendererKind.toUpperCase()} / {renderQuality.toUpperCase()}
                </span>
              </figcaption>
            </figure>

            <div className="mh-air-waves" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>

            <div className="mh-microphone" aria-hidden="true">
              <span className="mh-mic-capsule">
                <i />
                <i />
                <i />
                <i />
              </span>
              <span className="mh-mic-body" />
              <span className="mh-mic-mount" />
              <strong>MIC</strong>
              <small>VIRTUAL RETURN</small>
            </div>

            <div className="mh-feedback-cable" aria-hidden="true">
              <span className="mh-feedback-flow mh-flow-one" />
              <span className="mh-feedback-flow mh-flow-two" />
              <span className="mh-feedback-label">FEEDBACK LOOP</span>
            </div>
          </div>

          <div className="mh-instrumentation" aria-label="Read-only signal instruments">
            <div
              className="mh-oscilloscope"
              role="img"
              aria-label={`Microphone waveform; RMS ${oscilloscope.rmsPercent} percent, peak ${oscilloscope.peakPercent} percent`}
            >
              <div className="mh-instrument-label">
                <span>MIC SIGNAL</span>
                <strong>OSCILLOSCOPE</strong>
              </div>
              <div
                className="mh-scope-screen"
                aria-hidden="true"
                data-auto-gain={oscilloscope.autoGainLinear.toFixed(3)}
                data-display-peak={oscilloscope.displayPeakNormalized.toFixed(3)}
              >
                <i className="mh-scope-zero" />
                {oscilloscope.samples.map((sample, index) => {
                  const normalizedSample = Math.min(
                    1,
                    Math.max(-1, Number.isFinite(sample) ? sample : 0),
                  );
                  const sampleStyle = {
                    "--scope-magnitude": Math.abs(normalizedSample),
                  } as CSSProperties;
                  return (
                    <span
                      className="mh-scope-sample"
                      data-polarity={
                        normalizedSample < 0 ? "negative" : "positive"
                      }
                      key={index}
                      style={sampleStyle}
                    />
                  );
                })}
              </div>
              <p>
                RMS {oscilloscope.rmsPercent.toString().padStart(3, "0")}
                <span>
                  AUTO ×
                  {oscilloscope.autoGainLinear < 10
                    ? oscilloscope.autoGainLinear.toFixed(1)
                    : Math.round(oscilloscope.autoGainLinear)}
                </span>
                <span>
                  PEAK {oscilloscope.peakPercent.toString().padStart(3, "0")}
                </span>
              </p>
            </div>

            <div className="mh-phase-meter">
              <div className="mh-instrument-label">
                <span>LOOP ALIGNMENT</span>
                <strong>MODE PHASE</strong>
              </div>
              <div
                className="mh-phase-face"
                role="img"
                aria-label={`Active mode phase ${activeModePhase.toFixed(2)} radians`}
              >
                <i aria-hidden="true" />
                <span aria-hidden="true">0</span>
                <span aria-hidden="true">π</span>
              </div>
              <p>{activeModePhase.toFixed(2)} RAD</p>
            </div>
          </div>

          <div className="mh-measurement" aria-label="Measurement status">
            <div>
              <span>
                {measurementStatus === "measuring"
                  ? "MEASURING"
                  : "SETTLED"}
              </span>
              <strong>
                {Math.round(progress * 100).toString().padStart(3, "0")}%
              </strong>
            </div>
            <div className="mh-measurement-track" aria-hidden="true">
              <span />
            </div>
            <p>
              <span className="mh-envelope-dot" aria-hidden="true" />
              ENVELOPE {Math.round(visualEnvelope * 100)
                .toString()
                .padStart(3, "0")}
            </p>
          </div>
        </section>

        <section className="mh-output-panel" aria-labelledby="output-title">
          <div className="mh-section-heading">
            <span>03 / RESULT</span>
            <h2 id="output-title">Virtual output</h2>
          </div>

          <div className="mh-volume-readout">
            <span className="mh-output-label">VOLUME</span>
            <strong>{displayedVolume}</strong>
            <span className="mh-output-range">/ 100</span>
            <span className="mh-output-state">
              {measurementStatus === "measuring" ? "MEASURING" : "SETTLED"}
            </span>
            {challengeTarget !== null ? (
              <span className="mh-challenge-readonly">
                READ-ONLY TARGET{" "}
                {challengeTarget.toString().padStart(3, "0")}
              </span>
            ) : null}
          </div>
          <span
            className="mh-sr-only"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {stableAnnouncement}
          </span>

          <div className="mh-meter-block">
            <div className="mh-volume-meter" aria-hidden="true">
              <span className="mh-meter-fill" />
              <span className="mh-meter-grid" />
              {challengeTarget !== null ? (
                <span className="mh-target-line">
                  <i>TARGET {challengeTarget.toString().padStart(3, "0")}</i>
                </span>
              ) : null}
              <i className="mh-meter-mark mh-meter-mark-100">100</i>
              <i className="mh-meter-mark mh-meter-mark-75">75</i>
              <i className="mh-meter-mark mh-meter-mark-50">50</i>
              <i className="mh-meter-mark mh-meter-mark-25">25</i>
              <i className="mh-meter-mark mh-meter-mark-0">0</i>
            </div>
            <div className="mh-regime-card">
              <span>LOOP REGIME</span>
              <strong>
                <i aria-hidden="true" />
                {regimeCopy.label}
              </strong>
              <p>{regimeCopy.description}</p>
            </div>
          </div>

          {diagnosticTitle && diagnosticMessage ? (
            <aside
              className={`mh-diagnostic mh-diagnostic-${diagnosticSeverity}`}
              aria-label="System diagnostic"
            >
              <span>{diagnosticCode ?? "SYSTEM"}</span>
              <strong>{diagnosticTitle}</strong>
              <p>{diagnosticMessage}</p>
              {diagnosticDetail ? (
                <code className="mh-diagnostic-detail">
                  {diagnosticDetail}
                </code>
              ) : null}
            </aside>
          ) : null}

          <div className="mh-safety-note">
            <span aria-hidden="true">↳</span>
            <p>
              <strong>VIRTUAL LEVEL</strong>
              Listening gain remains independently limited.
            </p>
          </div>
        </section>
      </section>

      <footer className="mh-footer">
        <p>
          FREQUENCY
          <span aria-hidden="true">→</span>
          RESONANCE
          <span aria-hidden="true">→</span>
          FEEDBACK
          <span aria-hidden="true">→</span>
          VOLUME
        </p>
        <p>ONE CONTROL / ONE RESULT / NO RANDOMNESS</p>
        <p className="mh-prototype-status">
          {isVerifiedDataset
            ? "CONTENT-ADDRESSED / VERIFIED THIN-PLATE BAKE"
            : "ANALYTICAL PROTOTYPE / PRODUCTION BAKE PENDING"}
        </p>
      </footer>
    </main>
  );
}
