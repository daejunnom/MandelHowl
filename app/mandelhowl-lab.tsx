"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type WheelEvent,
} from "react";
import {
  createDialState,
  reduceDialState,
  stepDialState,
  type DialCommand,
  type DialKeyboardKey,
  type DialState,
} from "@/packages/dial-engine/src";
import {
  advanceResonance,
  createResonanceState,
  getResonanceSnapshot,
  type ResonanceSnapshot,
  type ResonanceState,
} from "@/packages/resonance-engine/src";
import { SafeAudioEngine } from "@/packages/audio-engine/src";
import { paintPrototypePlate } from "@/packages/render-engine/src";
import { MandelHowlScene } from "./mandelhowl-scene";

interface ViewState {
  dial: DialState;
  resonance: ResonanceSnapshot;
}

const DIAL_KEYS = new Set<string>([
  "ArrowLeft",
  "ArrowRight",
  "ArrowDown",
  "ArrowUp",
  "PageDown",
  "PageUp",
  "Home",
  "End",
]);

function dialCommandPoint(event: PointerEvent<HTMLDivElement>) {
  const bounds = event.currentTarget.getBoundingClientRect();
  return {
    point: {
      x: event.clientX,
      y: event.clientY,
    },
    center: {
      x: bounds.left + bounds.width / 2,
      y: bounds.top + bounds.height / 2,
    },
    deadZoneRadius: Math.max(22, Math.min(bounds.width, bounds.height) * 0.1),
  };
}

export function MandelHowlLab() {
  const [runtime] = useState(() => {
    const dial = createDialState({ initialFrequencyHz: 220 });
    return {
      dial,
      resonance: createResonanceState({
        initialFrequencyHz: dial.frequencyHz,
      }),
      audio: new SafeAudioEngine(),
    };
  });
  const dialRef = useRef<DialState>(runtime.dial);
  const resonanceRef = useRef<ResonanceState>(runtime.resonance);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioEngineRef = useRef<SafeAudioEngine>(runtime.audio);
  const reducedMotionRef = useRef(false);

  const [viewState, setViewState] = useState<ViewState>(() => ({
    dial: runtime.dial,
    resonance: getResonanceSnapshot(runtime.resonance),
  }));
  const [audioEnabled, setAudioEnabled] = useState(false);

  const dispatchDial = useCallback((command: DialCommand) => {
    if (!dialRef.current) {
      return;
    }
    dialRef.current = reduceDialState(dialRef.current, command);
  }, []);

  const activateAudio = useCallback(async () => {
    const active = await audioEngineRef.current?.activate();
    setAudioEnabled(Boolean(active));
  }, []);

  const onDialPointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (event.pointerType === "mouse" && event.button !== 0) {
        return;
      }

      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      const geometry = dialCommandPoint(event);
      dispatchDial({
        type: "pointer-start",
        ...geometry,
        timestampMs: event.timeStamp,
      });
      void activateAudio();
    },
    [activateAudio, dispatchDial],
  );

  const onDialPointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!dialRef.current?.dragging) {
        return;
      }

      event.preventDefault();
      dispatchDial({
        type: "pointer-move",
        ...dialCommandPoint(event),
        timestampMs: event.timeStamp,
      });
    },
    [dispatchDial],
  );

  const finishPointerGesture = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      dispatchDial({
        type: "pointer-end",
        timestampMs: event.timeStamp,
      });
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
    [dispatchDial],
  );

  const onDialKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (!DIAL_KEYS.has(event.key)) {
        return;
      }

      event.preventDefault();
      dispatchDial({
        type: "keyboard",
        key: event.key as DialKeyboardKey,
        timestampMs: event.timeStamp,
      });
      void activateAudio();
    },
    [activateAudio, dispatchDial],
  );

  const onDialWheel = useCallback(
    (event: WheelEvent<HTMLDivElement>) => {
      event.preventDefault();
      dispatchDial({
        type: "wheel",
        deltaY: event.deltaY,
        timestampMs: event.timeStamp,
      });
      void activateAudio();
    },
    [activateAudio, dispatchDial],
  );

  useEffect(() => {
    const audioEngine = audioEngineRef.current;
    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updateMotionPreference = () => {
      reducedMotionRef.current = motionQuery.matches;
    };
    updateMotionPreference();
    motionQuery.addEventListener("change", updateMotionPreference);

    let animationFrame = 0;
    let previousTime = performance.now();
    let previousPresentationTime = 0;

    const tick = (time: number) => {
      const elapsedSeconds = Math.min(
        0.1,
        Math.max(0, (time - previousTime) / 1000),
      );
      previousTime = time;

      const currentDial = dialRef.current;
      const currentResonance = resonanceRef.current;
      if (currentDial && currentResonance) {
        const steppedDial = stepDialState(currentDial, elapsedSeconds);
        const steppedResonance = advanceResonance(
          currentResonance,
          elapsedSeconds,
          {
            frequencyHz: steppedDial.frequencyHz,
            sweepHzPerSecond: steppedDial.frequencySweepHzPerSecond,
            direction: steppedDial.direction,
          },
        );
        const snapshot = getResonanceSnapshot(steppedResonance);

        dialRef.current = steppedDial;
        resonanceRef.current = steppedResonance;

        if (canvasRef.current) {
          paintPrototypePlate(
            canvasRef.current,
            {
              activeMode: snapshot.activeModeIndex ?? 0,
              feedbackEnvelope: snapshot.feedbackEnvelope,
              frequency: snapshot.frequencyHz,
              regime: snapshot.regime,
              simulationTime: snapshot.simulationTimeSeconds,
            },
            { reducedMotion: reducedMotionRef.current },
          );
        }

        audioEngine.applySnapshot({
          frequency: snapshot.frequencyHz,
          feedbackEnvelope: snapshot.feedbackEnvelope,
          activeMode: snapshot.activeModeIndex ?? 0,
          regime: snapshot.regime,
        });

        if (time - previousPresentationTime >= 32) {
          previousPresentationTime = time;
          setViewState({
            dial: steppedDial,
            resonance: snapshot,
          });
        }
      }

      animationFrame = window.requestAnimationFrame(tick);
    };

    animationFrame = window.requestAnimationFrame(tick);

    const silenceWhenHidden = () => {
      if (document.visibilityState === "hidden") {
        void audioEngine.suspend();
        setAudioEnabled(false);
      }
    };
    const disposeOnPageHide = () => {
      void audioEngine.dispose();
      setAudioEnabled(false);
    };

    document.addEventListener("visibilitychange", silenceWhenHidden);
    window.addEventListener("pagehide", disposeOnPageHide);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      motionQuery.removeEventListener("change", updateMotionPreference);
      document.removeEventListener("visibilitychange", silenceWhenHidden);
      window.removeEventListener("pagehide", disposeOnPageHide);
      void audioEngine.dispose();
    };
  }, []);

  return (
    <MandelHowlScene
      frequency={viewState.dial.frequencyHz}
      angle={viewState.dial.angleRadians}
      volume={viewState.resonance.volume}
      regime={viewState.resonance.regime}
      envelope={viewState.resonance.feedbackEnvelope}
      activeMode={viewState.resonance.activeModeIndex}
      measurementProgress={viewState.resonance.measurementProgress}
      audioEnabled={audioEnabled}
      dragging={viewState.dial.dragging}
      onDialPointerDown={onDialPointerDown}
      onDialPointerMove={onDialPointerMove}
      onDialPointerUp={finishPointerGesture}
      onDialPointerCancel={finishPointerGesture}
      onDialKeyDown={onDialKeyDown}
      onDialWheel={onDialWheel}
      canvasRef={canvasRef}
    />
  );
}
