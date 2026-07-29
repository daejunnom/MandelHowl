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
    1e-7,
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
  };
}

function pointerStart(
  state: DialState,
  command: Extract<DialCommand, { type: "pointer-start" }>,
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
  };
}

function pointerMove(
  state: DialState,
  command: Extract<DialCommand, { type: "pointer-move" }>,
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

  const rawDelta = unwrapAngleDelta(
    state.lastPointerAngleRadians,
    wrappedAngle,
  );
  const maximumDelta = state.config.maxPointerAngularVelocity * dt;
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
  const target = applyEndStopResistance(
    state.unwrappedAngleRadians + finiteOr(deltaRadians, 0),
    state.config,
  );
  const next = deriveDialState(state, target, 0, 0);
  return {
    ...next,
    dragging: false,
    lastPointerAngleRadians: null,
    lastPointerTimestampMs: null,
    lastUpdateTimestampMs:
      timestampMs === undefined
        ? state.lastUpdateTimestampMs
        : finiteOr(timestampMs, state.lastUpdateTimestampMs ?? 0),
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

  return deriveDialState(state, angle, velocity, elapsed);
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
    case "keyboard": {
      if (command.key === "Home" || command.key === "End") {
        const angle =
          command.key === "Home"
            ? state.config.minAngleRadians
            : state.config.maxAngleRadians;
        const next = deriveDialState(state, angle, 0, 0);
        return {
          ...next,
          lastUpdateTimestampMs:
            command.timestampMs === undefined
              ? state.lastUpdateTimestampMs
              : finiteOr(command.timestampMs, state.lastUpdateTimestampMs ?? 0),
        };
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
      const next = deriveDialState(state, angle, 0, 0);
      return {
        ...next,
        lastUpdateTimestampMs:
          command.timestampMs === undefined
            ? state.lastUpdateTimestampMs
            : finiteOr(command.timestampMs, state.lastUpdateTimestampMs ?? 0),
      };
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
