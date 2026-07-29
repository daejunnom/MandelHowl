"use client";

import type {
  CSSProperties,
  KeyboardEventHandler,
  PointerEventHandler,
  Ref,
  WheelEventHandler,
} from "react";
import "./mandelhowl.css";

export type MandelHowlRegime =
  | "decaying"
  | "critical"
  | "growing"
  | "saturated";

export interface MandelHowlSceneProps {
  /** Current drive frequency in hertz. */
  frequency: number;
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
  /** Whether the safe listening graph is enabled. This is display-only here. */
  audioEnabled: boolean;
  dragging: boolean;
  onDialPointerDown: PointerEventHandler<HTMLDivElement>;
  onDialPointerMove: PointerEventHandler<HTMLDivElement>;
  onDialPointerUp: PointerEventHandler<HTMLDivElement>;
  onDialPointerCancel: PointerEventHandler<HTMLDivElement>;
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

export function MandelHowlScene({
  frequency,
  angle,
  volume,
  regime,
  envelope,
  activeMode,
  measurementProgress,
  audioEnabled,
  dragging,
  onDialPointerDown,
  onDialPointerMove,
  onDialPointerUp,
  onDialPointerCancel,
  onDialKeyDown,
  onDialWheel,
  canvasRef,
}: MandelHowlSceneProps) {
  const progress = clampUnit(measurementProgress);
  const visualEnvelope = clampUnit(envelope);
  const displayedVolume = Math.round(volume).toString().padStart(3, "0");
  const displayedFrequency = formatFrequency(frequency);
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
  };

  return (
    <main
      className={`mh-shell mh-regime-${regime}${
        dragging ? " mh-is-dragging" : ""
      }`}
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
            <span>PLATE</span>
            MH–01 / CENTER CLAMP
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
            aria-valuemin={52}
            aria-valuemax={1250}
            aria-valuenow={Math.round(frequency)}
            aria-valuetext={`${displayedFrequency}, ${regimeCopy.label.toLowerCase()}`}
            aria-orientation="horizontal"
            onPointerDown={onDialPointerDown}
            onPointerMove={onDialPointerMove}
            onPointerUp={onDialPointerUp}
            onPointerCancel={onDialPointerCancel}
            onKeyDown={onDialKeyDown}
            onWheel={onDialWheel}
          >
            <span className="mh-dial-scale" aria-hidden="true" />
            <span className="mh-dial-track" aria-hidden="true" />
            <span className="mh-dial-label mh-dial-label-20" aria-hidden="true">
              52
            </span>
            <span className="mh-dial-label mh-dial-label-200" aria-hidden="true">
              150
            </span>
            <span className="mh-dial-label mh-dial-label-2k" aria-hidden="true">
              430
            </span>
            <span className="mh-dial-label mh-dial-label-20k" aria-hidden="true">
              1.25k
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
            <span className="mh-dial-cap" aria-hidden="true" />
          </div>

          <div className="mh-drive-footer" aria-label="Drive state">
            <span>LOG SWEEP</span>
            <span className="mh-drive-direction">
              <i aria-hidden="true">−</i>
              52 Hz
              <b aria-hidden="true" />
              1.25 kHz
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
            <div className="mh-mode-readout" role="status">
              <span>CAPTURE</span>
              <strong>{modeLabel}</strong>
            </div>
          </div>

          <div
            className="mh-apparatus"
            aria-label={`Signal path: speaker drives the Mandelbrot-encoded Chladni plate, microphone returns the response through the feedback loop. ${regimeCopy.label}, ${regimeCopy.description}.`}
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
                <span>MANDELBROT-ENCODED</span>
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
                <span>FINITE MODAL DATA</span>
                <span>NODAL SAND MAP</span>
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

          <div className="mh-measurement" aria-label="Measurement status">
            <div>
              <span>MEASUREMENT WINDOW</span>
              <strong>{Math.round(progress * 100).toString().padStart(3, "0")}%</strong>
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

          <div className="mh-volume-readout" aria-live="polite" aria-atomic="true">
            <span className="mh-output-label">VOLUME</span>
            <strong>{displayedVolume}</strong>
            <span className="mh-output-range">/ 100</span>
          </div>

          <div className="mh-meter-block">
            <div className="mh-volume-meter" aria-hidden="true">
              <span className="mh-meter-fill" />
              <span className="mh-meter-grid" />
              <i className="mh-meter-mark mh-meter-mark-100">100</i>
              <i className="mh-meter-mark mh-meter-mark-75">75</i>
              <i className="mh-meter-mark mh-meter-mark-50">50</i>
              <i className="mh-meter-mark mh-meter-mark-25">25</i>
              <i className="mh-meter-mark mh-meter-mark-0">0</i>
            </div>
            <div className="mh-regime-card" role="status">
              <span>LOOP REGIME</span>
              <strong>
                <i aria-hidden="true" />
                {regimeCopy.label}
              </strong>
              <p>{regimeCopy.description}</p>
            </div>
          </div>

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
          PROTOTYPE MODAL FIXTURE / FEM BAKE PENDING
        </p>
      </footer>
    </main>
  );
}
