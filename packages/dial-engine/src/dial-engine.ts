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

type MutableDialState = {
  -readonly [Key in keyof DialState]: DialState[Key];
};

function writeDerivedDialState(
  state: MutableDialState,
  angleRadians: number,
  velocityRadiansPerSecond: number,
  elapsedSeconds: number,
): void {
  const previousFrequency = state.frequencyHz;
  const previousStoppedSeconds = state.stoppedSeconds;
  const angle = finiteOr(angleRadians, state.unwrappedAngleRadians);
  const effectiveAngle = clampToDialRange(angle, state.config);
  const frequency = angleToFrequency(effectiveAngle, state.config);
  const dt = Math.max(0, finiteOr(elapsedSeconds, 0));
  const sweep = dt > 0 ? (frequency - previousFrequency) / dt : 0;
  const velocity = finiteOr(velocityRadiansPerSecond, 0);
  const direction = signWithDeadBand(
    Math.abs(sweep) > 1e-7 ? sweep : velocity,
    Math.abs(sweep) > 1e-7
      ? state.config.approachDirectionThresholdHzPerSecond
      : state.config.stationaryVelocityThreshold,
  );
  const stopped =
    direction === 0 && Math.abs(velocity) <= state.config.inertiaStopVelocity
      ? previousStoppedSeconds + dt
      : 0;
  state.unwrappedAngleRadians = angle;
  state.angleRadians = angle;
  state.effectiveAngleRadians = effectiveAngle;
  state.angularVelocityRadiansPerSecond = velocity;
  state.previousFrequencyHz = previousFrequency;
  state.frequencyHz = frequency;
  state.frequencySweepHzPerSecond = finiteOr(sweep, 0);
  state.direction = direction;
  state.stoppedSeconds = stopped;
}

function deriveDialState(
  state: DialState,
  angleRadians: number,
  velocityRadiansPerSecond: number,
  elapsedSeconds: number,
): DialState {
  const next = { ...state };
  writeDerivedDialState(
    next,
    angleRadians,
    velocityRadiansPerSecond,
    elapsedSeconds,
  );
  return next;
}

function ageRecentPointerVelocity(
  state: DialState,
  elapsedSeconds: number,
): number {
  const elapsed = Math.max(0, finiteOr(elapsedSeconds, 0));
  const velocity =
    state.angularVelocityRadiansPerSecond *
    Math.exp(-elapsed / state.config.velocityHistoryWindowSeconds);
  return Math.abs(velocity) <=
    Math.max(
      state.config.stationaryVelocityThreshold,
      state.config.inertiaStopVelocity,
    )
    ? 0
    : velocity;
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
  const next = deriveDialState(
    state,
    state.unwrappedAngleRadians,
    0,
    0,
  );
  return {
    ...next,
    stoppedSeconds: 0,
    dragging: true,
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
  if (
    state.lastPointerTimestampMs !== null &&
    timestampMs <= state.lastPointerTimestampMs
  ) {
    // The timestamp is the deterministic sample-order boundary. Re-anchoring
    // on a duplicate or stale event would turn the next valid sample into a
    // dial jump that the pointer never traversed.
    return state;
  }
  const deadZone = command.deadZoneRadius ?? state.config.radialDeadZone;
  if (!isOutsideRadialDeadZone(command.point, command.center, deadZone)) {
    const elapsed = Math.max(
      0,
      (timestampMs - (state.lastPointerTimestampMs ?? timestampMs)) / 1000,
    );
    return {
      ...deriveDialState(state, state.unwrappedAngleRadians, 0, elapsed),
      stoppedSeconds: state.stoppedSeconds + elapsed,
      dragging: true,
      lastPointerAngleRadians: null,
      lastPointerTimestampMs: timestampMs,
      lastUpdateTimestampMs: timestampMs,
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
      ...deriveDialState(state, state.unwrappedAngleRadians, 0, dt),
      stoppedSeconds: state.stoppedSeconds + dt,
      dragging: true,
      lastPointerAngleRadians: wrappedAngle,
      lastPointerTimestampMs: timestampMs,
      lastUpdateTimestampMs: timestampMs,
      inertiaElapsedSeconds: 0,
    };
  }

  const rawDelta = unwrapAngleDelta(
    state.lastPointerAngleRadians,
    wrappedAngle,
    state.config.unwrapPeriodRadians,
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
    1 - Math.exp(-dt / state.config.velocityHistoryWindowSeconds),
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
  const timestamp = Math.max(
    state.lastUpdateTimestampMs ?? 0,
    finiteOr(timestampMs, state.lastUpdateTimestampMs ?? 0),
  );
  const elapsedSincePointerSample =
    state.lastPointerTimestampMs === null
      ? 0
      : Math.max(0, (timestamp - state.lastPointerTimestampMs) / 1000);
  const unobservedElapsed = Math.max(
    0,
    elapsedSincePointerSample - state.stoppedSeconds,
  );
  const recentVelocity = ageRecentPointerVelocity(state, unobservedElapsed);
  const next = deriveDialState(
    state,
    state.unwrappedAngleRadians,
    clamp(
      recentVelocity,
      -state.config.maximumInitialInertiaVelocity,
      state.config.maximumInitialInertiaVelocity,
    ),
    0,
  );
  return {
    ...next,
    stoppedSeconds: Math.max(
      state.stoppedSeconds,
      elapsedSincePointerSample,
    ),
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
  if (
    timestamp !== null &&
    state.lastUpdateTimestampMs !== null &&
    timestamp < state.lastUpdateTimestampMs
  ) {
    return state;
  }
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
    const velocity = ageRecentPointerVelocity(state, elapsed);
    return {
      ...deriveDialState(
        state,
        state.unwrappedAngleRadians,
        velocity,
        elapsed,
      ),
      stoppedSeconds: state.stoppedSeconds + elapsed,
      dragging: true,
    };
  }

  if (
    state.inertiaElapsedSeconds >=
      state.config.inertiaMaximumDurationSeconds &&
    state.unwrappedAngleRadians >= state.config.minAngleRadians &&
    state.unwrappedAngleRadians <= state.config.maxAngleRadians
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

/**
 * Allocation-free production tick. Input commands continue to use the
 * immutable reducer boundary, while RAF advancement mutates only this
 * session-owned state using scalar integration locals.
 */
export function stepDialStateInPlace(
  state: DialState,
  deltaSeconds: number,
): DialState {
  const mutable = state as MutableDialState;
  const requested = Math.max(0, finiteOr(deltaSeconds, 0));
  const elapsed = Math.min(requested, state.config.maxAdvanceSeconds);
  if (elapsed === 0) return state;

  if (state.dragging) {
    const previousStoppedSeconds = state.stoppedSeconds;
    writeDerivedDialState(
      mutable,
      state.unwrappedAngleRadians,
      ageRecentPointerVelocity(state, elapsed),
      elapsed,
    );
    mutable.stoppedSeconds = previousStoppedSeconds + elapsed;
    mutable.dragging = true;
    return state;
  }

  if (
    state.inertiaElapsedSeconds >=
      state.config.inertiaMaximumDurationSeconds &&
    state.unwrappedAngleRadians >= state.config.minAngleRadians &&
    state.unwrappedAngleRadians <= state.config.maxAngleRadians
  ) {
    writeDerivedDialState(
      mutable,
      state.unwrappedAngleRadians,
      0,
      elapsed,
    );
    return state;
  }

  let remaining = elapsed;
  let angle = state.unwrappedAngleRadians;
  let velocity = state.angularVelocityRadiansPerSecond;
  while (remaining > 1e-12) {
    const dt = Math.min(remaining, state.config.integrationStepSeconds);
    const below = Math.min(0, angle - state.config.minAngleRadians);
    const above = Math.max(0, angle - state.config.maxAngleRadians);
    const displacement = below + above;
    const springAcceleration =
      displacement === 0
        ? 0
        : -state.config.endStopStiffness * displacement -
          state.config.endStopDamping * velocity;
    velocity += springAcceleration * dt;
    velocity *= Math.exp(
      -state.config.inertiaFrictionPerSecond * dt,
    );
    velocity = clamp(
      velocity,
      -state.config.maxPointerAngularVelocity,
      state.config.maxPointerAngularVelocity,
    );
    angle += velocity * dt;
    angle = clamp(
      angle,
      state.config.minAngleRadians -
        state.config.endStopOverscrollRadians,
      state.config.maxAngleRadians +
        state.config.endStopOverscrollRadians,
    );
    if (
      angle >= state.config.minAngleRadians &&
      angle <= state.config.maxAngleRadians &&
      Math.abs(velocity) < state.config.inertiaStopVelocity
    ) {
      velocity = 0;
    }
    const endStopSnapDistance =
      state.config.inertiaStopVelocity *
      Math.max(state.config.integrationStepSeconds, dt);
    if (
      angle < state.config.minAngleRadians &&
      Math.abs(angle - state.config.minAngleRadians) <=
        endStopSnapDistance &&
      Math.abs(velocity) < state.config.inertiaStopVelocity
    ) {
      angle = state.config.minAngleRadians;
      velocity = 0;
    } else if (
      angle > state.config.maxAngleRadians &&
      Math.abs(angle - state.config.maxAngleRadians) <=
        endStopSnapDistance &&
      Math.abs(velocity) < state.config.inertiaStopVelocity
    ) {
      angle = state.config.maxAngleRadians;
      velocity = 0;
    }
    remaining -= dt;
  }

  const previousInertiaElapsed = state.inertiaElapsedSeconds;
  writeDerivedDialState(mutable, angle, velocity, elapsed);
  mutable.inertiaElapsedSeconds =
    velocity === 0
      ? previousInertiaElapsed
      : Math.min(
          state.config.inertiaMaximumDurationSeconds,
          previousInertiaElapsed + elapsed,
        );
  return state;
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
