import {
  GENERATED_DIAL_SPEC,
  toCentiHertz,
  type DialGestureTrace,
  type DialTraceCommand,
  type DialTraceEvent,
} from "../../contracts/src";
import type { DialCommand } from "./dial-command";
import {
  createDialState,
  reduceDialState,
  stepDialState,
} from "./dial-engine";
import type { DialConfig, DialState } from "./dial-state";

export interface DialTraceReplayResult {
  readonly finalState: DialState;
  readonly eventStates: readonly DialState[];
}
export interface CreateDialGestureTraceOptions {
  readonly traceId: string;
  readonly initialFrequencyCentiHz: number;
  readonly durationSeconds?: number;
}

export function createDialGestureTrace(
  options: CreateDialGestureTraceOptions,
): DialGestureTrace {
  return Object.freeze({
    schemaVersion: "mandelhowl.dial-gesture-trace.v2",
    traceId: options.traceId,
    initialFrequencyCentiHz: options.initialFrequencyCentiHz,
    durationSeconds: Math.max(0, options.durationSeconds ?? 0),
    events: Object.freeze([]),
  });
}

function withoutTimestamp(command: DialCommand): DialTraceCommand {
  switch (command.type) {
    case "pointer-start":
    case "pointer-move":
      return {
        type: command.type,
        point: { ...command.point },
        center: { ...command.center },
        ...(command.deadZoneRadius === undefined
          ? {}
          : { deadZoneRadius: command.deadZoneRadius }),
      };
    case "pointer-end":
    case "pointer-cancel":
      return { type: command.type };
    case "keyboard":
      return {
        type: "keyboard",
        key: command.key,
      };
    case "wheel":
      return { type: "wheel", deltaY: command.deltaY };
    case "nudge":
      return { type: "nudge", deltaRadians: command.deltaRadians };
    case "set-frequency":
      return {
        type: "set-frequency",
        frequencyCentiHz: command.frequencyCentiHz,
      };
    case "advance":
    case "reset":
      throw new Error(
        `Dial trace records physical input commands, not ${command.type}`,
      );
  }
}

export function recordDialTraceCommand(
  trace: DialGestureTrace,
  atSeconds: number,
  command: DialCommand,
): DialGestureTrace {
  const time = Number.isFinite(atSeconds) ? Math.max(0, atSeconds) : 0;
  const previous = trace.events.at(-1);
  if (previous && time < previous.atSeconds) {
    throw new Error("Dial trace events must be recorded in time order");
  }
  const event: DialTraceEvent = Object.freeze({
    sequence: trace.events.length,
    atSeconds: time,
    command: Object.freeze(withoutTimestamp(command)),
  });
  return Object.freeze({
    ...trace,
    durationSeconds: Math.max(trace.durationSeconds, time),
    events: Object.freeze([...trace.events, event]),
  });
}

function replayCommand(
  command: DialTraceCommand,
  timestampMs: number,
): DialCommand {
  switch (command.type) {
    case "pointer-start":
    case "pointer-move":
      return { ...command, timestampMs };
    case "pointer-end":
    case "pointer-cancel":
      return { type: command.type, timestampMs };
    case "keyboard":
      return { ...command, timestampMs };
    case "wheel":
      return { ...command, timestampMs };
    case "nudge":
      return { ...command, timestampMs };
    case "set-frequency":
      return { ...command, timestampMs };
  }
}

export function validateDialGestureTrace(
  trace: DialGestureTrace,
): readonly string[] {
  const errors: string[] = [];
  const minimumFrequencyCentiHz = toCentiHertz(
    GENERATED_DIAL_SPEC.mapping.minimumFrequencyHz,
  );
  const maximumFrequencyCentiHz = toCentiHertz(
    GENERATED_DIAL_SPEC.mapping.maximumFrequencyHz,
  );
  if (trace.schemaVersion !== "mandelhowl.dial-gesture-trace.v2") {
    errors.push("TRACE_SCHEMA_VERSION_UNSUPPORTED");
  }
  if (
    !Number.isSafeInteger(trace.initialFrequencyCentiHz) ||
    trace.initialFrequencyCentiHz < minimumFrequencyCentiHz ||
    trace.initialFrequencyCentiHz > maximumFrequencyCentiHz
  ) {
    errors.push("TRACE_INITIAL_FREQUENCY_INVALID");
  }
  if (!Number.isFinite(trace.durationSeconds) || trace.durationSeconds < 0) {
    errors.push("TRACE_DURATION_INVALID");
  }
  let previousTime = 0;
  trace.events.forEach((event, index) => {
    if (event.sequence !== index) errors.push("TRACE_SEQUENCE_INVALID");
    if (
      !Number.isFinite(event.atSeconds) ||
      event.atSeconds < previousTime ||
      event.atSeconds > trace.durationSeconds
    ) {
      errors.push("TRACE_TIME_INVALID");
    }
    if (
      event.command.type === "set-frequency" &&
      (!Number.isSafeInteger(event.command.frequencyCentiHz) ||
        event.command.frequencyCentiHz < minimumFrequencyCentiHz ||
        event.command.frequencyCentiHz > maximumFrequencyCentiHz)
    ) {
      errors.push("TRACE_FREQUENCY_INVALID");
    }
    previousTime = event.atSeconds;
  });
  return Object.freeze([...new Set(errors)]);
}

export function replayDialGestureTrace(
  trace: DialGestureTrace,
  config?: Partial<Omit<DialConfig, "version">>,
): DialTraceReplayResult {
  const errors = validateDialGestureTrace(trace);
  if (errors.length > 0) {
    throw new Error(`Invalid dial trace: ${errors.join(", ")}`);
  }

  let state = createDialState({
    config,
    initialFrequencyCentiHz: trace.initialFrequencyCentiHz,
  });
  let elapsed = 0;
  const eventStates: DialState[] = [];
  for (const event of trace.events) {
    state = stepDialState(state, event.atSeconds - elapsed);
    elapsed = event.atSeconds;
    state = reduceDialState(
      state,
      replayCommand(event.command, event.atSeconds * 1000),
    );
    eventStates.push(state);
  }
  state = stepDialState(state, trace.durationSeconds - elapsed);
  return Object.freeze({
    finalState: state,
    eventStates: Object.freeze(eventStates),
  });
}
