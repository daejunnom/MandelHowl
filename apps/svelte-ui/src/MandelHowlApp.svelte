<script lang="ts">
  import { onMount, tick } from "svelte";
  import {
    canStartDialPointerGesture,
    createDialKeyboardCommand,
    createDialPointerCommand,
    createDialWheelCommand,
    isDialKeyboardKey,
    resolveDatasetPresentationState,
    type MandelHowlBrowserRuntimePort,
    type MandelHowlUiSnapshot,
    type MandelHowlViewAttachment,
  } from "../../../packages/browser-runtime/src";
  import type { DialCommand } from "../../../packages/dial-engine/src";
  import {
    CANONICAL_SCENE_LAYOUT,
    formatVirtualVolume,
    measurementStatusLabel,
    presentCausalMotion,
    presentOscilloscope,
  } from "../../../packages/presentation-model/src";
  import { oscilloscopeSampleCountForQuality } from "../../../packages/render-engine/src";
  import {
    GENERATED_MOTION_SAFETY_SPEC,
    GENERATED_SCENE_SPEC,
  } from "../../../packages/contracts/src";

  interface Props {
    runtime: MandelHowlBrowserRuntimePort;
    onReady?: () => void;
    onHeartbeat?: (sequence: number) => void;
    onAvailabilityFailure?: (error: unknown) => void;
  }

  const REGIME_COPY = {
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
  } as const;

  let {
    runtime,
    onReady,
    onHeartbeat,
    onAvailabilityFailure,
  }: Props = $props();

  // The port identity is reactive for adapter-level remount tests, while
  // subscription deliveries can optimistically replace the current value.
  let presentation = $derived<MandelHowlUiSnapshot>(
    runtime.presentation.getSnapshot(),
  );
  let dialElement: HTMLDivElement | null = null;
  let activePointerId: number | null = null;
  let plateAttachment: MandelHowlViewAttachment | null = null;
  let plateAttached = false;
  let readyReported = false;
  let detached = false;

  let snapshot = $derived(presentation.runtime);
  let frequency = $derived(snapshot.dial.driveFrequencyHz);
  let frequencyMin = $derived(presentation.minimumFrequencyHz);
  let frequencyMax = $derived(presentation.maximumFrequencyHz);
  let progress = $derived(clampUnit(snapshot.volume.progress));
  let visualEnvelope = $derived(
    clampUnit(snapshot.feedback.envelopeNormalized),
  );
  let volume = $derived(
    snapshot.volume.status === "settled"
      ? snapshot.volume.value
      : (snapshot.volume.lastSettledValue ?? 0),
  );
  let displayedVolume = $derived(
    formatVirtualVolume(volume),
  );
  let measurementLabel = $derived(
    measurementStatusLabel(snapshot.volume.status),
  );
  let displayedFrequency = $derived(formatFrequency(frequency));
  let frequencyTicks = $derived(
    [
      frequencyMin,
      logarithmicTick(frequencyMin, frequencyMax, 1 / 3),
      logarithmicTick(frequencyMin, frequencyMax, 2 / 3),
      frequencyMax,
    ].map(formatCompactFrequency),
  );
  let activeModeIndex = $derived(
    snapshot.activeModeId === null
      ? -1
      : snapshot.modes.findIndex(
          (mode) => mode.modeId === snapshot.activeModeId,
        ),
  );
  let activeModePhase = $derived(
    activeModeIndex >= 0
      ? (snapshot.modes[activeModeIndex]?.phaseRad ?? 0)
      : 0,
  );
  let modeLabel = $derived(
    activeModeIndex < 0
      ? "NO MODE"
      : `MODE ${String(activeModeIndex + 1).padStart(2, "0")}`,
  );
  let regimeCopy = $derived(REGIME_COPY[snapshot.regime]);
  let datasetPresentationState = $derived(
    resolveDatasetPresentationState(presentation),
  );
  let isVerifiedDataset = $derived(
    datasetPresentationState === "verified",
  );
  let isStreamingDataset = $derived(
    datasetPresentationState === "streaming",
  );
  let rendererKind = $derived(presentation.renderer?.kind ?? "static");
  let renderQuality = $derived(
    presentation.renderer?.quality ?? "reduced",
  );
  let renderDegradationStage = $derived(
    presentation.renderer?.degradationStage ?? 0,
  );
  let materialSectionReady = $derived(
    presentation.renderer?.materialSectionReady ?? false,
  );
  let oscilloscope = $derived(
    presentOscilloscope({
      recentSamples: snapshot.microphone.recentSamples,
      rmsNormalized: snapshot.microphone.rmsNormalized,
      peakNormalized: snapshot.microphone.peakNormalized,
      sampleCount: oscilloscopeSampleCountForQuality(
        renderQuality,
        renderDegradationStage,
      ),
    }),
  );
  let causalMotion = $derived(
    presentCausalMotion({
      driveFrequencyHz: frequency,
      minimumFrequencyHz: frequencyMin,
      maximumFrequencyHz: frequencyMax,
      feedbackEnvelopeNormalized: visualEnvelope,
      microphoneRmsNormalized: snapshot.microphone.rmsNormalized,
    }),
  );
  let stableAnnouncement = $derived(
    snapshot.volume.status === "settled"
      ? `Volume settled at ${displayedVolume} out of 100.`
      : "",
  );
  let sceneStyle = $derived(
    [
      `--dial-angle: ${snapshot.dial.unwrappedAngleRad}rad`,
      `--envelope: ${visualEnvelope}`,
      `--measurement: ${Math.round(progress * 100)}%`,
      `--volume: ${volume}`,
      `--target-volume: ${presentation.challengeTarget ?? 0}`,
      `--drive-cycle: ${causalMotion.driveCycleSeconds}s`,
      `--return-cycle: ${causalMotion.returnCycleSeconds}s`,
      `--feedback-cycle: ${causalMotion.feedbackCycleSeconds}s`,
      `--status-cycle: ${causalMotion.statusCycleSeconds}s`,
      `--speaker-travel: ${causalMotion.speakerTravelNormalized}`,
      `--microphone-level: ${causalMotion.microphoneLevelNormalized}`,
      `--feedback-level: ${causalMotion.feedbackLevelNormalized}`,
      `--forced-border-width: ${GENERATED_MOTION_SAFETY_SPEC.forcedColors.minimumBorderWidthPx}px`,
      `--speaker-center-x: ${CANONICAL_SCENE_LAYOUT.speakerCenterXPercent}%`,
      `--speaker-center-y: ${CANONICAL_SCENE_LAYOUT.speakerCenterYPercent}%`,
      `--plate-center-x: ${CANONICAL_SCENE_LAYOUT.plateCenterXPercent}%`,
      `--plate-center-y: ${CANONICAL_SCENE_LAYOUT.plateCenterYPercent}%`,
      `--microphone-center-x: ${CANONICAL_SCENE_LAYOUT.microphoneCenterXPercent}%`,
      `--microphone-center-y: ${CANONICAL_SCENE_LAYOUT.microphoneCenterYPercent}%`,
    ].join("; "),
  );

  function clampUnit(value: number): number {
    return Math.min(1, Math.max(0, value));
  }

  function formatFrequency(value: number): string {
    if (value >= 1_000) {
      const precision = value < 10_000 ? 2 : 1;
      return `${(value / 1_000).toFixed(precision)} kHz`;
    }
    return `${value.toFixed(value < 100 ? 1 : 0)} Hz`;
  }

  function formatCompactFrequency(value: number): string {
    if (value >= 1_000) {
      return `${Number((value / 1_000).toPrecision(3))}k`;
    }
    return `${Math.round(value)}`;
  }

  function logarithmicTick(
    minimum: number,
    maximum: number,
    normalized: number,
  ): number {
    return minimum * Math.pow(maximum / minimum, normalized);
  }

  function reportViewFailure(error: unknown): void {
    try {
      onAvailabilityFailure?.(error);
    } catch {
      // A supervisor callback must not recursively break the view boundary.
    }
  }

  function dispatch(command: DialCommand): boolean {
    try {
      runtime.dispatchDial(command);
      return true;
    } catch (error) {
      reportViewFailure(error);
      return false;
    }
  }

  function setDragging(value: boolean): void {
    try {
      runtime.setDragging(value);
    } catch (error) {
      reportViewFailure(error);
    }
  }

  function activateAudio(): void {
    // Invoke synchronously from the trusted input event. Awaiting before this
    // call would lose the browser's user-activation token.
    try {
      void runtime.activateAudio().catch(() => {
        // Audio unavailability is a shared capability diagnostic, not a
        // framework-view failure and therefore must not trigger UI failover.
      });
    } catch {
      // Synchronous AudioContext construction failures are handled by the
      // safe audio engine and reflected through presentation diagnostics.
    }
  }

  function onDialPointerDown(event: PointerEvent): void {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (!canStartDialPointerGesture(activePointerId)) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    const element = event.currentTarget;
    if (!(element instanceof HTMLDivElement)) return;

    try {
      element.setPointerCapture(event.pointerId);
    } catch {
      // Assistive pointer adapters do not always expose pointer capture.
    }
    activePointerId = event.pointerId;
    if (
      dispatch(
        createDialPointerCommand({
          type: "pointer-start",
          clientX: event.clientX,
          clientY: event.clientY,
          timestampMs: event.timeStamp,
          bounds: element.getBoundingClientRect(),
          radialDeadZone: presentation.radialDeadZone,
        }),
      )
    ) {
      setDragging(true);
    }
    activateAudio();
  }

  function onDialPointerMove(event: PointerEvent): void {
    if (activePointerId !== event.pointerId) return;
    event.preventDefault();
    const element = event.currentTarget;
    if (!(element instanceof HTMLDivElement)) return;
    dispatch(
      createDialPointerCommand({
        type: "pointer-move",
        clientX: event.clientX,
        clientY: event.clientY,
        timestampMs: event.timeStamp,
        bounds: element.getBoundingClientRect(),
        radialDeadZone: presentation.radialDeadZone,
      }),
    );
  }

  function finishPointerGesture(
    event: PointerEvent,
    commandType: "pointer-end" | "pointer-cancel",
  ): void {
    if (activePointerId !== event.pointerId) return;
    event.preventDefault();
    const element = event.currentTarget;
    activePointerId = null;
    dispatch({
      type: commandType,
      timestampMs: event.timeStamp,
    });
    setDragging(false);
    if (
      element instanceof HTMLDivElement &&
      element.hasPointerCapture(event.pointerId)
    ) {
      element.releasePointerCapture(event.pointerId);
    }
  }

  function onDialLostPointerCapture(event: PointerEvent): void {
    if (activePointerId !== event.pointerId) return;
    activePointerId = null;
    dispatch({
      type: "pointer-end",
      timestampMs: event.timeStamp,
    });
    setDragging(false);
  }

  function onDialKeyDown(event: KeyboardEvent): void {
    if (!isDialKeyboardKey(event.key)) return;
    event.preventDefault();
    dispatch(createDialKeyboardCommand(event.key, event.timeStamp));
    activateAudio();
  }

  function onDialWheel(event: WheelEvent): void {
    event.preventDefault();
    dispatch(createDialWheelCommand(event.deltaY, event.timeStamp));
    activateAudio();
  }

  function mountPlate(canvas: HTMLCanvasElement): { destroy(): void } {
    try {
      plateAttachment?.detach();
      const sourceAttachment = runtime.mountPlate(canvas);
      let attachmentDetached = false;
      const attachment: MandelHowlViewAttachment = {
        detach() {
          if (attachmentDetached) return;
          attachmentDetached = true;
          sourceAttachment.detach();
        },
      };
      plateAttachment = attachment;
      plateAttached = true;
      return {
        destroy() {
          if (plateAttachment === attachment) {
            plateAttachment = null;
          }
          plateAttached = false;
          attachment.detach();
        },
      };
    } catch (error) {
      reportViewFailure(error);
      return { destroy() {} };
    }
  }

  function handleBoundaryError(error: unknown): void {
    reportViewFailure(error);
  }

  onMount(() => {
    const unsubscribe = runtime.presentation.subscribe((next) => {
      if (detached) return;
      presentation = next;
      void tick()
        .then(() => {
          if (!detached) onHeartbeat?.(next.runtime.sequence);
        })
        .catch(reportViewFailure);
    });

    void tick()
      .then(() => {
        if (detached || readyReported) return;
        if (!dialElement || !plateAttached) {
          reportViewFailure(
            new Error("Svelte view did not attach its dial and plate."),
          );
          return;
        }
        readyReported = true;
        onReady?.();
        onHeartbeat?.(presentation.runtime.sequence);
      })
      .catch(reportViewFailure);

    return () => {
      detached = true;
      unsubscribe();
      if (activePointerId !== null) {
        dispatch({
          type: "pointer-cancel",
          timestampMs: performance.now(),
        });
        activePointerId = null;
        setDragging(false);
      }
      plateAttachment?.detach();
      plateAttachment = null;
      plateAttached = false;
    };
  });
</script>

<svelte:boundary onerror={handleBoundaryError}>
  <main
    class={`mh-shell mh-regime-${snapshot.regime}${
      presentation.dragging ? " mh-is-dragging" : ""
    } mh-measurement-${snapshot.volume.status}`}
    data-regime={snapshot.regime}
    data-ui-implementation="svelte5"
    data-ui-revision={presentation.revision}
    data-render-degradation={renderDegradationStage}
    data-snapshot-sequence={snapshot.sequence}
    data-scene-read-order={GENERATED_SCENE_SPEC.readOrder.join(">")}
    data-conceptual-input-count={GENERATED_SCENE_SPEC.inputCount}
    data-conceptual-output-count={GENERATED_SCENE_SPEC.outputCount}
    data-camera-projection={GENERATED_SCENE_SPEC.camera.projection}
    data-camera-fov={GENERATED_SCENE_SPEC.camera.fieldOfViewDegrees}
    data-camera-clip={`${GENERATED_SCENE_SPEC.camera.near},${GENERATED_SCENE_SPEC.camera.far}`}
    style={sceneStyle}
  >
    <header class="mh-header">
      <div class="mh-brand" aria-label="MandelHowl">
        <span class="mh-brand-mark" aria-hidden="true">
          <span></span>
        </span>
        <div>
          <p class="mh-kicker">Experimental acoustic interface</p>
          <h1>MandelHowl</h1>
        </div>
      </div>

      <div class="mh-header-readouts" aria-label="System status">
        <p>
          <span>DATASET</span>
          {isVerifiedDataset
            ? "VERIFIED THIN-PLATE BAKE"
            : isStreamingDataset
              ? "VERIFIED BAKE / TEXTURES STREAMING"
              : datasetPresentationState === "loading"
                ? "DATASET VERIFICATION PENDING"
                : datasetPresentationState === "error"
                  ? "DATASET UNAVAILABLE"
                  : "PROTOTYPE / CENTER CLAMP"}
        </p>
        <p
          class={presentation.audioEnabled
            ? "mh-audio-on"
            : "mh-audio-off"}
          role="status"
        >
          <span class="mh-status-dot" aria-hidden="true"></span>
          {presentation.audioEnabled
            ? "SAFE MONITOR ACTIVE"
            : "MONITOR MUTED"}
        </p>
      </div>
    </header>

    <section class="mh-workbench" aria-label="MandelHowl experiment">
      <section class="mh-drive-panel" aria-labelledby="drive-title">
        <div class="mh-section-heading">
          <span>01 / DRIVE</span>
          <h2 id="drive-title">Frequency input</h2>
        </div>

        <div
          bind:this={dialElement}
          class="mh-dial"
          role="slider"
          tabindex="0"
          aria-label="Drive frequency"
          aria-valuemin={frequencyMin}
          aria-valuemax={frequencyMax}
          aria-valuenow={Math.round(frequency)}
          aria-valuetext={`${displayedFrequency}, ${regimeCopy.label.toLowerCase()}`}
          aria-orientation="horizontal"
          onpointerdown={onDialPointerDown}
          onpointermove={onDialPointerMove}
          onpointerup={(event) => finishPointerGesture(event, "pointer-end")}
          onpointercancel={(event) =>
            finishPointerGesture(event, "pointer-cancel")}
          onlostpointercapture={onDialLostPointerCapture}
          onkeydown={onDialKeyDown}
          onwheel={onDialWheel}
        >
          <span class="mh-dial-scale" aria-hidden="true"></span>
          <span class="mh-dial-track" aria-hidden="true"></span>
          <span
            class="mh-dial-label mh-dial-label-20"
            aria-hidden="true"
          >
            {frequencyTicks[0]}
          </span>
          <span
            class="mh-dial-label mh-dial-label-200"
            aria-hidden="true"
          >
            {frequencyTicks[1]}
          </span>
          <span
            class="mh-dial-label mh-dial-label-2k"
            aria-hidden="true"
          >
            {frequencyTicks[2]}
          </span>
          <span
            class="mh-dial-label mh-dial-label-20k"
            aria-hidden="true"
          >
            {frequencyTicks[3]}
          </span>

          <span class="mh-dial-face">
            <span class="mh-dial-type">DRIVE FREQUENCY</span>
            <strong>{displayedFrequency}</strong>
            <span class="mh-dial-hint">
              {presentation.dragging ? "SWEEPING" : "DRAG · KEYS · WHEEL"}
            </span>
          </span>

          <span class="mh-dial-pointer" aria-hidden="true">
            <span></span>
          </span>
        </div>

        <div class="mh-drive-footer" aria-label="Drive state">
          <span>LOG SWEEP</span>
          <span class="mh-drive-direction">
            <i aria-hidden="true">−</i>
            {formatFrequency(frequencyMin)}
            <b aria-hidden="true"></b>
            {formatFrequency(frequencyMax)}
            <i aria-hidden="true">+</i>
          </span>
        </div>
      </section>

      <section
        class="mh-apparatus-panel"
        aria-labelledby="apparatus-title"
      >
        <div class="mh-section-heading mh-section-heading-wide">
          <div>
            <span>02 / RESONATOR</span>
            <h2 id="apparatus-title">Closed-loop Chladni apparatus</h2>
          </div>
          <div class="mh-mode-readout">
            <span>CAPTURE</span>
            <strong>{modeLabel}</strong>
          </div>
        </div>

        <div
          class="mh-apparatus"
          data-renderer-kind={rendererKind}
          aria-label={`Signal path: speaker drives the ${
            isVerifiedDataset
              ? "verified Mandelbrot-encoded thin-plate bake"
              : isStreamingDataset
                ? "verified thin-plate metadata with texture shards streaming and an analytical fallback"
              : "explicitly labelled analytical prototype plate"
          }, microphone returns the response through the feedback loop. ${regimeCopy.label}, ${regimeCopy.description}.`}
        >
          <!-- svelte-ignore a11y_no_interactive_element_to_noninteractive_role -->
          <canvas
            use:mountPlate
            class="mh-apparatus-canvas mh-plate-canvas"
            role="img"
            aria-label={`Animated virtual speaker, Chladni plate and sand, virtual microphone, and feedback cable at ${displayedFrequency}; ${modeLabel.toLowerCase()}; ${
              materialSectionReady
                ? "precomputed Mandelbrot material thickness cutaway visible at the lower plate edge"
                : isVerifiedDataset
                  ? "verified modal dataset without an available material thickness cutaway"
                  : isStreamingDataset
                    ? "verified modal metadata with texture shards streaming through an analytical fallback"
                    : "analytical prototype without a verified material cutaway"
            }`}
          >
            Closed-loop Chladni apparatus visualization at
            {displayedFrequency}.
          </canvas>
          <div
            class="mh-signal-key mh-signal-key-drive"
            aria-hidden="true"
          >
            <span>DRIVE</span>
            <i></i>
          </div>
          <div
            class="mh-signal-key mh-signal-key-return"
            aria-hidden="true"
          >
            <span>RETURN</span>
            <i></i>
          </div>

          <div
            class="mh-speaker"
            aria-hidden="true"
            data-apparatus-position={GENERATED_SCENE_SPEC.apparatus.speaker.position.join(",")}
          >
            <span class="mh-speaker-frame">
              <span class="mh-speaker-cone">
                <i></i>
              </span>
            </span>
            <strong>SPEAKER</strong>
            <small>EXCITER 01</small>
          </div>

          <div class="mh-drive-waves" aria-hidden="true">
            <span></span>
            <span></span>
            <span></span>
          </div>

          <figure
            class="mh-plate-assembly"
            data-apparatus-position={GENERATED_SCENE_SPEC.apparatus.plate.position.join(",")}
          >
            <div class="mh-plate-title">
              <span>
                {isVerifiedDataset
                  ? "MANDELBROT-ENCODED / THIN PLATE"
                  : isStreamingDataset
                    ? "VERIFIED BASIS / STREAMING TEXTURES"
                  : "ANALYTICAL PROTOTYPE"}
              </span>
              <strong>METAL PLATE + SAND</strong>
            </div>
            <div class="mh-plate-brace" aria-hidden="true">
              <span></span>
              <span></span>
              <span></span>
              <span></span>
            </div>
            <div class="mh-plate-hardware">
              <div class="mh-plate-surface">
                <span class="mh-plate-sheen" aria-hidden="true"></span>
                <span class="mh-center-clamp" aria-hidden="true">
                  <i></i>
                </span>
              </div>
            </div>
            <figcaption>
              <span>
                {isVerifiedDataset
                  ? "VERIFIED MODAL DATA"
                  : isStreamingDataset
                    ? "VERIFIED SHARDS PENDING"
                    : "DETERMINISTIC PREVIEW"}
              </span>
              <span>
                {rendererKind.toUpperCase()} / {renderQuality.toUpperCase()}
              </span>
            </figcaption>
          </figure>

          <div class="mh-air-waves" aria-hidden="true">
            <span></span>
            <span></span>
            <span></span>
          </div>

          <div
            class="mh-microphone"
            aria-hidden="true"
            data-apparatus-position={GENERATED_SCENE_SPEC.apparatus.microphone.position.join(",")}
          >
            <span class="mh-mic-capsule">
              <i></i>
              <i></i>
              <i></i>
              <i></i>
            </span>
            <span class="mh-mic-body"></span>
            <span class="mh-mic-mount"></span>
            <strong>MIC</strong>
            <small>VIRTUAL RETURN</small>
          </div>

          <div
            class="mh-feedback-cable"
            aria-hidden="true"
            data-signal-direction={GENERATED_SCENE_SPEC.apparatus.cable.direction}
          >
            <span class="mh-feedback-flow mh-flow-one"></span>
            <span class="mh-feedback-flow mh-flow-two"></span>
            <span class="mh-feedback-label">FEEDBACK LOOP</span>
          </div>
        </div>

        <div
          class="mh-instrumentation"
          aria-label="Read-only signal instruments"
        >
          <div
            class="mh-oscilloscope"
            role="img"
            aria-label={`Microphone waveform; RMS ${oscilloscope.rmsPercent} percent, peak ${oscilloscope.peakPercent} percent`}
          >
            <div class="mh-instrument-label">
              <span>MIC SIGNAL</span>
              <strong>OSCILLOSCOPE</strong>
            </div>
            <div
              class="mh-scope-screen"
              aria-hidden="true"
              data-auto-gain={oscilloscope.autoGainLinear.toFixed(3)}
              data-display-peak={oscilloscope.displayPeakNormalized.toFixed(3)}
              data-sample-count={oscilloscope.samples.length}
            >
              <i class="mh-scope-zero"></i>
              {#each oscilloscope.samples as sample, index (index)}
                <span
                  class="mh-scope-sample"
                  data-polarity={sample < 0 ? "negative" : "positive"}
                  style={`--scope-magnitude: ${Math.abs(
                    Math.min(
                      1,
                      Math.max(-1, Number.isFinite(sample) ? sample : 0),
                    ),
                  )}`}
                ></span>
              {/each}
            </div>
            <p>
              RMS {oscilloscope.rmsPercent.toString().padStart(3, "0")}
              <span>
                AUTO ×{oscilloscope.autoGainLinear < 10
                  ? oscilloscope.autoGainLinear.toFixed(1)
                  : Math.round(oscilloscope.autoGainLinear)}
              </span>
              <span>
                PEAK {oscilloscope.peakPercent.toString().padStart(3, "0")}
              </span>
              {#if snapshot.regime === "critical"}
                <span class="mh-scope-phase-emphasis">
                  PHASE {activeModePhase.toFixed(2)} RAD
                </span>
              {/if}
            </p>
          </div>
        </div>

        <div class="mh-measurement" aria-label="Measurement status">
          <div>
            <span>
              {measurementLabel}
            </span>
            <strong>
              {Math.round(progress * 100).toString().padStart(3, "0")}%
            </strong>
          </div>
          <div class="mh-measurement-track" aria-hidden="true">
            <span></span>
          </div>
          <p>
            <span class="mh-envelope-dot" aria-hidden="true"></span>
            ENVELOPE {Math.round(visualEnvelope * 100)
              .toString()
              .padStart(3, "0")}
          </p>
        </div>
      </section>

      <section class="mh-output-panel" aria-labelledby="output-title">
        <div class="mh-section-heading">
          <span>03 / RESULT</span>
          <h2 id="output-title">Virtual output</h2>
        </div>

        <div class="mh-volume-readout">
          <span class="mh-output-label">VOLUME</span>
          <strong>{displayedVolume}</strong>
          <span class="mh-output-range">/ 100</span>
          <span class="mh-output-state">
            {measurementLabel}
          </span>
          {#if presentation.challengeTarget !== null}
            <span class="mh-challenge-readonly">
              READ-ONLY TARGET {formatVirtualVolume(
                presentation.challengeTarget,
              )}
            </span>
          {/if}
        </div>
        <span
          class="mh-sr-only"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {stableAnnouncement}
        </span>

        <div class="mh-meter-block">
          <div class="mh-volume-meter" aria-hidden="true">
            <span class="mh-meter-fill"></span>
            <span class="mh-meter-grid"></span>
            {#if presentation.challengeTarget !== null}
              <span class="mh-target-line">
                <i>
                  TARGET {formatVirtualVolume(
                    presentation.challengeTarget,
                  )}
                </i>
              </span>
            {/if}
            <i class="mh-meter-mark mh-meter-mark-100">100</i>
            <i class="mh-meter-mark mh-meter-mark-75">75</i>
            <i class="mh-meter-mark mh-meter-mark-50">50</i>
            <i class="mh-meter-mark mh-meter-mark-25">25</i>
            <i class="mh-meter-mark mh-meter-mark-0">0</i>
          </div>
          <div class="mh-regime-card">
            <span>LOOP REGIME</span>
            <strong>
              <i aria-hidden="true"></i>
              {regimeCopy.label}
            </strong>
            <p>{regimeCopy.description}</p>
          </div>
        </div>

        {#if
          presentation.diagnostic.title &&
          presentation.diagnostic.message}
          <aside
            class={`mh-diagnostic mh-diagnostic-${presentation.diagnostic.severity}`}
            aria-label="System diagnostic"
          >
            <span>{presentation.diagnostic.code ?? "SYSTEM"}</span>
            <strong>{presentation.diagnostic.title}</strong>
            <p>{presentation.diagnostic.message}</p>
            {#if presentation.diagnostic.detail}
              <code class="mh-diagnostic-detail">
                {presentation.diagnostic.detail}
              </code>
            {/if}
          </aside>
        {/if}

        <div class="mh-safety-note">
          <span aria-hidden="true">↳</span>
          <p>
            <strong>VIRTUAL LEVEL</strong>
            Listening gain remains independently limited.
          </p>
        </div>
      </section>
    </section>

    <footer class="mh-footer">
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
      <p class="mh-prototype-status">
        {isVerifiedDataset
          ? "CONTENT-ADDRESSED / VERIFIED THIN-PLATE BAKE"
          : isStreamingDataset
            ? "CONTENT-ADDRESSED / VERIFIED TEXTURES STREAMING"
          : "ANALYTICAL PROTOTYPE / PRODUCTION BAKE PENDING"}
      </p>
    </footer>
  </main>

  {#snippet failed()}
    <main
      class="mh-shell mh-regime-decaying"
      data-ui-implementation="svelte5"
      data-ui-failed="true"
      aria-live="assertive"
    >
      <aside
        class="mh-diagnostic mh-diagnostic-fatal"
        aria-label="System diagnostic"
      >
        <span>MH-UI-SVELTE-FAILED</span>
        <strong>Svelte view unavailable</strong>
        <p>The runtime supervisor is switching to the standby view.</p>
      </aside>
    </main>
  {/snippet}
</svelte:boundary>
