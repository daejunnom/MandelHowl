import { describe, expect, it } from "vitest";
import {
  createDialGestureTrace,
  createDialState,
  recordDialTraceCommand,
  reduceDialState,
  replayDialGestureTrace,
} from "./index";

describe("canonical dial engine", () => {
  it("uses the generated 45..6000 Hz logarithmic range", () => {
    const state = createDialState();
    expect(state.config.minFrequencyHz).toBe(45);
    expect(state.config.maxFrequencyHz).toBe(6000);

    const home = reduceDialState(state, {
      type: "keyboard",
      key: "Home",
      timestampMs: 16,
    });
    const end = reduceDialState(home, {
      type: "keyboard",
      key: "End",
      timestampMs: 32,
    });
    expect(home.frequencyHz).toBeCloseTo(45, 12);
    expect(end.frequencyHz).toBeCloseTo(6000, 10);
  });

  it("gives keyboard and wheel adapters the same sweep history semantics", () => {
    const initial = createDialState({ initialFrequencyHz: 220 });
    const keyboard = reduceDialState(initial, {
      type: "keyboard",
      key: "ArrowRight",
      timestampMs: 16,
    });
    const wheel = reduceDialState(keyboard, {
      type: "wheel",
      deltaY: -20,
      timestampMs: 32,
    });

    expect(keyboard.previousFrequencyHz).toBe(initial.frequencyHz);
    expect(keyboard.frequencySweepHzPerSecond).toBeGreaterThan(0);
    expect(keyboard.direction).toBe(1);
    expect(wheel.previousFrequencyHz).toBe(keyboard.frequencyHz);
    expect(wheel.frequencySweepHzPerSecond).toBeGreaterThan(0);
    expect(wheel.direction).toBe(1);
  });

  it("rejects stale pointer deltas and cleans a cancelled gesture", () => {
    let state = createDialState({ initialFrequencyHz: 220 });
    state = reduceDialState(state, {
      type: "pointer-start",
      point: { x: 100, y: 0 },
      center: { x: 0, y: 0 },
      deadZoneRadius: 10,
      timestampMs: 0,
    });
    const before = state.frequencyHz;
    state = reduceDialState(state, {
      type: "pointer-move",
      point: { x: 0, y: 100 },
      center: { x: 0, y: 0 },
      deadZoneRadius: 10,
      timestampMs: 1000,
    });
    expect(state.frequencyHz).toBe(before);
    state = reduceDialState(state, {
      type: "pointer-cancel",
      timestampMs: 1001,
    });
    expect(state.dragging).toBe(false);
    expect(state.lastPointerAngleRadians).toBeNull();
  });

  it("records and replays a deterministic gesture trace", () => {
    let trace = createDialGestureTrace({
      traceId: "keyboard-wheel-history",
      initialFrequencyHz: 220,
      durationSeconds: 0.2,
    });
    trace = recordDialTraceCommand(trace, 0.05, {
      type: "keyboard",
      key: "ArrowRight",
      timestampMs: 99_999,
    });
    trace = recordDialTraceCommand(trace, 0.1, {
      type: "wheel",
      deltaY: -12,
      timestampMs: 88_888,
    });
    const first = replayDialGestureTrace(trace);
    const second = replayDialGestureTrace(trace);
    expect(first.finalState).toEqual(second.finalState);
    expect(first.finalState.frequencyHz).toBeGreaterThan(220);
    expect(first.eventStates).toHaveLength(2);
  });
});
