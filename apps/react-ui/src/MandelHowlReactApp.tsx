"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useSyncExternalStore,
  type KeyboardEvent,
  type PointerEvent,
  type WheelEvent,
} from "react";
import {
  canStartDialPointerGesture,
  createDialKeyboardCommand,
  createDialPointerCommand,
  createDialWheelCommand,
  isDialKeyboardKey,
  resolveDatasetPresentationState,
  type MandelHowlBrowserRuntimePort,
  type MandelHowlViewAttachment,
} from "../../../packages/browser-runtime/src";
import { MandelHowlScene } from "../../../app/mandelhowl-scene";

interface MandelHowlReactAppProps {
  readonly runtime: MandelHowlBrowserRuntimePort;
  readonly onReady?: () => void;
  readonly onHeartbeat?: (sequence: number) => void;
  readonly onAvailabilityFailure?: (error: unknown) => void;
}

export function MandelHowlReactApp({
  runtime,
  onReady,
  onHeartbeat,
  onAvailabilityFailure,
}: MandelHowlReactAppProps) {
  const subscribe = useCallback(
    (consumer: () => void) => runtime.presentation.subscribe(consumer),
    [runtime],
  );
  const getSnapshot = useCallback(
    () => runtime.presentation.getSnapshot(),
    [runtime],
  );
  const presentation = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getSnapshot,
  );
  const activePointerIdRef = useRef<number | null>(null);
  const plateAttachmentRef = useRef<MandelHowlViewAttachment | null>(null);
  const readyReportedRef = useRef(false);

  const reportFailure = useCallback(
    (error: unknown) => {
      try {
        onAvailabilityFailure?.(error);
      } catch {
        // Supervisor observers cannot be allowed to break this adapter.
      }
    },
    [onAvailabilityFailure],
  );

  const dispatch = useCallback(
    (command: Parameters<typeof runtime.dispatchDial>[0]) => {
      try {
        runtime.dispatchDial(command);
        return true;
      } catch (error) {
        reportFailure(error);
        return false;
      }
    },
    [reportFailure, runtime],
  );

  const setDragging = useCallback(
    (dragging: boolean) => {
      try {
        runtime.setDragging(dragging);
      } catch (error) {
        reportFailure(error);
      }
    },
    [reportFailure, runtime],
  );

  const activateAudio = useCallback(() => {
    try {
      void runtime.activateAudio().catch(() => {
        // Audio capability errors are shared diagnostics, not view failures.
      });
    } catch {
      // SafeAudioEngine reports synchronous construction failures itself.
    }
  }, [runtime]);

  const attachPlate = useCallback(
    (canvas: HTMLCanvasElement | null) => {
      plateAttachmentRef.current?.detach();
      plateAttachmentRef.current = null;
      if (!canvas) return;
      try {
        plateAttachmentRef.current = runtime.mountPlate(canvas);
      } catch (error) {
        reportFailure(error);
      }
    },
    [reportFailure, runtime],
  );

  useEffect(() => {
    onHeartbeat?.(presentation.runtime.sequence);
    if (!readyReportedRef.current && plateAttachmentRef.current) {
      readyReportedRef.current = true;
      onReady?.();
    }
  }, [onHeartbeat, onReady, presentation]);

  useEffect(
    () => () => {
      if (activePointerIdRef.current !== null) {
        dispatch({
          type: "pointer-cancel",
          timestampMs: performance.now(),
        });
        activePointerIdRef.current = null;
        setDragging(false);
      }
      plateAttachmentRef.current?.detach();
      plateAttachmentRef.current = null;
    },
    [dispatch, setDragging],
  );

  const onDialPointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      if (!canStartDialPointerGesture(activePointerIdRef.current)) {
        event.preventDefault();
        return;
      }
      event.preventDefault();
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Pointer capture is optional for assistive pointer adapters.
      }
      activePointerIdRef.current = event.pointerId;
      if (
        dispatch(
          createDialPointerCommand({
            type: "pointer-start",
            clientX: event.clientX,
            clientY: event.clientY,
            timestampMs: event.timeStamp,
            bounds: event.currentTarget.getBoundingClientRect(),
            radialDeadZone: presentation.radialDeadZone,
          }),
        )
      ) {
        setDragging(true);
      }
      activateAudio();
    },
    [
      activateAudio,
      dispatch,
      presentation.radialDeadZone,
      setDragging,
    ],
  );

  const onDialPointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (activePointerIdRef.current !== event.pointerId) return;
      event.preventDefault();
      dispatch(
        createDialPointerCommand({
          type: "pointer-move",
          clientX: event.clientX,
          clientY: event.clientY,
          timestampMs: event.timeStamp,
          bounds: event.currentTarget.getBoundingClientRect(),
          radialDeadZone: presentation.radialDeadZone,
        }),
      );
    },
    [dispatch, presentation.radialDeadZone],
  );

  const finishPointerGesture = useCallback(
    (
      event: PointerEvent<HTMLDivElement>,
      commandType: "pointer-end" | "pointer-cancel",
    ) => {
      if (activePointerIdRef.current !== event.pointerId) return;
      event.preventDefault();
      activePointerIdRef.current = null;
      dispatch({ type: commandType, timestampMs: event.timeStamp });
      setDragging(false);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
    [dispatch, setDragging],
  );

  const onDialLostPointerCapture = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (activePointerIdRef.current !== event.pointerId) return;
      activePointerIdRef.current = null;
      dispatch({ type: "pointer-end", timestampMs: event.timeStamp });
      setDragging(false);
    },
    [dispatch, setDragging],
  );

  const onDialKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (!isDialKeyboardKey(event.key)) return;
      event.preventDefault();
      const command = createDialKeyboardCommand(
        event.key,
        event.timeStamp,
        event.shiftKey,
      );
      if (command === null) return;
      dispatch(command);
      activateAudio();
    },
    [activateAudio, dispatch],
  );

  const onDialWheel = useCallback(
    (event: WheelEvent<HTMLDivElement>) => {
      event.preventDefault();
      dispatch(createDialWheelCommand(event.deltaY, event.timeStamp));
      activateAudio();
    },
    [activateAudio, dispatch],
  );

  const snapshot = presentation.runtime;
  const capturedIndex =
    snapshot.activeModeId === null
      ? -1
      : snapshot.modes.findIndex(
          (mode) => mode.modeId === snapshot.activeModeId,
        );
  const volume =
    snapshot.volume.status === "settled"
      ? snapshot.volume.value
      : (snapshot.volume.lastSettledValue ?? 0);
  const diagnostic = presentation.diagnostic;
  const datasetPresentationState =
    resolveDatasetPresentationState(presentation);

  return (
    <MandelHowlScene
      frequencyCentiHz={snapshot.dial.driveFrequencyCentiHz}
      frequency={snapshot.dial.driveFrequencyHz}
      snapshotSequence={snapshot.sequence}
      frequencyMin={presentation.minimumFrequencyHz}
      frequencyMax={presentation.maximumFrequencyHz}
      angle={snapshot.dial.unwrappedAngleRad}
      volume={volume}
      regime={snapshot.regime}
      envelope={snapshot.feedback.envelopeNormalized}
      activeMode={capturedIndex < 0 ? null : capturedIndex}
      activeModePhase={
        capturedIndex < 0
          ? 0
          : (snapshot.modes[capturedIndex]?.phaseRad ?? 0)
      }
      measurementProgress={snapshot.volume.progress}
      measurementStatus={snapshot.volume.status}
      microphoneRms={snapshot.microphone.rmsNormalized}
      microphonePeak={snapshot.microphone.peakNormalized}
      microphoneSamples={snapshot.microphone.recentSamples}
      audioEnabled={presentation.audioEnabled}
      rendererKind={presentation.renderer?.kind ?? "static"}
      renderQuality={presentation.renderer?.quality ?? "reduced"}
      renderDegradationStage={
        presentation.renderer?.degradationStage ?? 0
      }
      materialSectionReady={
        presentation.renderer?.materialSectionReady ?? false
      }
      datasetStatus={datasetPresentationState}
      diagnosticSeverity={diagnostic.severity}
      diagnosticTitle={diagnostic.title}
      diagnosticMessage={diagnostic.message}
      diagnosticCode={diagnostic.code}
      diagnosticDetail={diagnostic.detail}
      challengeTarget={presentation.challengeTarget}
      dragging={presentation.dragging}
      onDialPointerDown={onDialPointerDown}
      onDialPointerMove={onDialPointerMove}
      onDialPointerUp={(event) => finishPointerGesture(event, "pointer-end")}
      onDialPointerCancel={(event) =>
        finishPointerGesture(event, "pointer-cancel")
      }
      onDialLostPointerCapture={onDialLostPointerCapture}
      onDialKeyDown={onDialKeyDown}
      onDialWheel={onDialWheel}
      canvasRef={attachPlate}
    />
  );
}
