import { estimateAngularVelocity } from "./angular-velocity";
import type { DialCommand, DialKeyboardKey } from "./dial-command";
import {
  createDialConfig,
  type DialConfig,
  type DialState,
} from "./dial-state";
import { applyEndStopResistance, clampToDialRange } from "./end-stop";
import { angleToFrequency, frequencyToAngle } from "./frequency-scale";
import { integrateDialInertia } from "./inertia";
import { clamp, finiteOr, signWithDeadBand } from "./math";
import {
  isOutsideRadialDeadZone,
  pointerAngleRadians,
} from "./radial-dead-zone";
import { unwrapAngleDelta } from "./unwrap-angle";

function deriveDialState(
  state: DialState,
  angleRadians: number,
  velocityRadiansPerSecond: number,
  elapsedSeconds: number,
): DialState {
  const angle = finiteOr(angleRadians, state.unwrappedAngleRadians);
  const effectiveAngle = clampToDialRange(angle, state.config);
  const frequency = angleToFrequency(effectiveAngle, state.config);
  const dt = Math.max(0, finiteOr(elapsedSeconds, 0));
  const sweep = dt > 0 ? (frequency - state.frequencyHz) / dt : 0;
  const velocity = finiteOr(velocityRadiansPerSecond, 0);
  const direction = signWithDeadBand(
    Math.abs(sweep) > 1e-7 ? sweep : velocity,
    Math.abs(sweep) > 1e-7
      ? state.config.approachDirectionThresholdHzPerSecond
      : state.config.stationaryVelocityThreshold,
  );
  const stopped =
    direction === 0 && Math.abs(velocity) <= state.config.inertiaStopVelocity
      ? state.stoppedSeconds + dt
      : 0;

  return {
    ...state,
    unwrappedAngleRadians: angle,
    angleRadians: angle,
    effectiveAngleRadians: effectiveAngle,
    angularVelocityRadiansPerSecond: velocity,
    previousFrequencyHz: state.frequencyHz,
    frequencyHz: frequency,
    frequencySweepHzPerSecond: finiteOr(sweep, 0),
    direction,
    stoppedSeconds: stopped,
  };
}

export function createDialState(
  options: {
    readonly config?: Partial<Omit<DialConfig, "version">>;
    readonly initialFrequencyHz?: number;
    readonly initialAngleRadians?: number;
  } = {},
): DialState {
  const config = createDialConfig(options.config);
  const initialAngle =
    options.initialAngleRadians === undefined
      ? frequencyToAngle(
          finiteOr(options.initialFrequencyHz ?? 220, 220),
          config,
        )
      : clampToDialRange(options.initialAngleRadians, config);
  const frequency = angleToFrequency(initialAngle, config);
  return {
    version: "mandelhowl.dial-state.v1",
    config,
    unwrappedAngleRadians: initialAngle,
    angleRadians: initialAngle,
    effectiveAngleRadians: initialAngle,
    angularVelocityRadiansPerSecond: 0,
    frequencyHz: frequency,
    previousFrequencyHz: frequency,
    frequencySweepHzPerSecond: 0,
    direction: 0,
    stoppedSeconds: 0,
    dragging: false,
    lastPointerAngleRadians: null,
    lastPointerTimestampMs: null,
    lastUpdateTimestampMs: null,
    inertiaElapsedSeconds: 0,
  };
}

function pointerStart(
  state: DialState,
  command: Extract<DialCommand, { point: unknown }>,
): DialState {
  const deadZone = command.deadZoneRadius ?? state.config.radialDeadZone;
  const usable = isOutsideRadialDeadZone(command.point, command.center, deadZone);
  return {
    ...state,
    dragging: true,
    angularVelocityRadiansPerSecond: 0,
    lastPointerAngleRadians: usable
      ? pointerAngleRadians(command.point, command.center)
      : null,
    lastPointerTimestampMs: finiteOr(command.timestampMs, 0),
    lastUpdateTimestampMs: finiteOr(command.timestampMs, 0),
    inertiaElapsedSeconds: 0,
  };
}

function pointerMove(
  state: DialState,
  command: Extract<DialCommand, { point: unknown }>,
): DialState {
  if (!state.dragging) return state;
  const timestampMs = finiteOr(
    command.timestampMs,
    state.lastPointerTimestampMs ?? 0,
  );
  const deadZone = command.deadZoneRadius ?? state.config.radialDeadZone;
  if (!isOutsideRadialDeadZone(command.point, command.center, deadZone)) {
    return {
      ...state,
      lastPointerAngleRadians: null,
      lastPointerTimestampMs: timestampMs,
      lastUpdateTimestampMs: timestampMs,
      angularVelocityRadiansPerSecond: 0,
    };
  }

  const wrappedAngle = pointerAngleRadians(command.point, command.center);
  if (state.lastPointerAngleRadians === null) {
    return {
      ...state,
      lastPointerAngleRadians: wrappedAngle,
      lastPointerTimestampMs: timestampMs,
      lastUpdateTimestampMs: timestampMs,
    };
  }

  const dt = Math.max(
    0,
    (timestampMs - (state.lastPointerTimestampMs ?? timestampMs)) / 1000,
  );
  if (dt === 0) {
    return {
      ...state,
      lastPointerAngleRadians: wrappedAngle,
      lastPointerTimestampMs: timestampMs,
      lastUpdateTimestampMs: timestampMs,
    };
  }

  if (dt > state.config.maximumPointerSampleGapSeconds) {
    return {
      ...state,
      lastPointerAngleRadians: wrappedAngle,
      lastPointerTimestampMs: timestampMs,
      lastUpdateTimestampMs: timestampMs,
      angularVelocityRadiansPerSecond: 0,
      inertiaElapsedSeconds: 0,
    };
  }

  const rawDelta = unwrapAngleDelta(
    state.lastPointerAngleRadians,
    wrappedAngle,
  );
  const maximumDelta = Math.min(
    state.config.maximumPointerDeltaRadians,
    state.config.maxPointerAngularVelocity * dt,
  );
  const filteredDelta = clamp(rawDelta, -maximumDelta, maximumDelta);
  const targetAngle = applyEndStopResistance(
    state.unwrappedAngleRadians + filteredDelta,
    state.config,
  );
  const appliedDelta = targetAngle - state.unwrappedAngleRadians;
  const velocity = estimateAngularVelocity(
    appliedDelta,
    dt,
    state.angularVelocityRadiansPerSecond,
    state.config.velocitySmoothing,
    state.config.maxPointerAngularVelocity,
  );

  return {
    ...deriveDialState(state, targetAngle, velocity, dt),
    dragging: true,
    lastPointerAngleRadians: wrappedAngle,
    lastPointerTimestampMs: timestampMs,
    lastUpdateTimestampMs: timestampMs,
    inertiaElapsedSeconds: 0,
  };
}

function pointerEnd(
  state: DialState,
  timestampMs: number,
): DialState {
  if (!state.dragging) return state;
  const timestamp = finiteOr(timestampMs, state.lastUpdateTimestampMs ?? 0);
  return {
    ...state,
    dragging: false,
    lastPointerAngleRadians: null,
    lastPointerTimestampMs: null,
    lastUpdateTimestampMs: timestamp,
    inertiaElapsedSeconds: 0,
  };
}

function keyboardDelta(key: DialKeyboardKey, config: DialConfig): number | null {
  switch (key) {
    case "ArrowLeft":
    case "ArrowDown":
      return -config.keyboardStepRadians;
    case "ArrowRight":
    case "ArrowUp":
      return config.keyboardStepRadians;
    case "PageDown":
      return -config.keyboardPageStepRadians;
    case "PageUp":
      return config.keyboardPageStepRadians;
    default:
      return null;
  }
}

function nudge(
  state: DialState,
  deltaRadians: number,
  timestampMs?: number,
): DialState {
  const timestamp =
    timestampMs === undefined
      ? state.lastUpdateTimestampMs
      : finiteOr(timestampMs, state.lastUpdateTimestampMs ?? 0);
  const rawElapsed =
    timestamp !== null && state.lastUpdateTimestampMs !== null
      ? (timestamp - state.lastUpdateTimestampMs) / 1000
      : state.config.integrationStepSeconds;
  const elapsed = clamp(
    finiteOr(rawElapsed, state.config.integrationStepSeconds),
    state.config.integrationStepSeconds,
    state.config.maximumPointerSampleGapSeconds,
  );
  const target = applyEndStopResistance(
    state.unwrappedAngleRadians + finiteOr(deltaRadians, 0),
    state.config,
  );
  const appliedDelta = target - state.unwrappedAngleRadians;
  const velocity = clamp(
    appliedDelta / elapsed,
    -state.config.maxPointerAngularVelocity,
    state.config.maxPointerAngularVelocity,
  );
  const next = deriveDialState(state, target, velocity, elapsed);
  return {
    ...next,
    dragging: false,
    lastPointerAngleRadians: null,
    lastPointerTimestampMs: null,
    lastUpdateTimestampMs: timestamp,
    inertiaElapsedSeconds: 0,
  };
}

export function stepDialState(
  state: DialState,
  deltaSeconds: number,
): DialState {
  const requested = Math.max(0, finiteOr(deltaSeconds, 0));
  const elapsed = Math.min(requested, state.config.maxAdvanceSeconds);
  if (elapsed === 0) return state;

  if (state.dragging) {
    return {
      ...state,
      stoppedSeconds:
        Math.abs(state.angularVelocityRadiansPerSecond) <
        state.config.inertiaStopVelocity
          ? state.stoppedSeconds + elapsed
          : 0,
    };
  }

  if (
    state.inertiaElapsedSeconds >=
    state.config.inertiaMaximumDurationSeconds
  ) {
    return deriveDialState(state, state.unwrappedAngleRadians, 0, elapsed);
  }

  let remaining = elapsed;
  let angle = state.unwrappedAngleRadians;
  let velocity = state.angularVelocityRadiansPerSecond;
  while (remaining > 1e-12) {
    const dt = Math.min(remaining, state.config.integrationStepSeconds);
    const integrated = integrateDialInertia(
      {
        angleRadians: angle,
        angularVelocityRadiansPerSecond: velocity,
      },
      dt,
      state.config,
    );
    angle = integrated.angleRadians;
    velocity = integrated.angularVelocityRadiansPerSecond;
    remaining -= dt;
  }

  const next = deriveDialState(state, angle, velocity, elapsed);
  return {
    ...next,
    inertiaElapsedSeconds:
      velocity === 0
        ? state.inertiaElapsedSeconds
        : Math.min(
            state.config.inertiaMaximumDurationSeconds,
            state.inertiaElapsedSeconds + elapsed,
          ),
  };
}

export function reduceDialState(
  state: DialState,
  command: DialCommand,
): DialState {
  switch (command.type) {
    case "pointer-start":
      return pointerStart(state, command);
    case "pointer-move":
      return pointerMove(state, command);
    case "pointer-end":
      return pointerEnd(state, command.timestampMs);
    case "pointer-cancel":
      return pointerEnd(state, command.timestampMs);
    case "keyboard": {
      if (command.key === "Home" || command.key === "End") {
        const angle =
          command.key === "Home"
            ? state.config.minAngleRadians
            : state.config.maxAngleRadians;
        return nudge(
          state,
          angle - state.unwrappedAngleRadians,
          command.timestampMs,
        );
      }
      return nudge(
        state,
        keyboardDelta(command.key, state.config) ?? 0,
        command.timestampMs,
      );
    }
    case "wheel": {
      const delta = clamp(
        -finiteOr(command.deltaY, 0) * state.config.wheelRadiansPerUnit,
        -state.config.maxWheelStepRadians,
        state.config.maxWheelStepRadians,
      );
      return nudge(state, delta, command.timestampMs);
    }
    case "nudge":
      return nudge(state, command.deltaRadians, command.timestampMs);
    case "set-frequency": {
      const angle = frequencyToAngle(command.frequencyHz, state.config);
      return nudge(
        state,
        angle - state.unwrappedAngleRadians,
        command.timestampMs,
      );
    }
    case "advance":
      return stepDialState(state, command.deltaSeconds);
    case "reset":
      return createDialState({
        config: command.config ?? state.config,
        initialFrequencyHz: command.frequencyHz ?? 220,
      });
  }
}
