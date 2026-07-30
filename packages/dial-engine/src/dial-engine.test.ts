import { describe, expect, it } from "vitest";
import {
  GENERATED_DIAL_SPEC,
} from "../../contracts/src";
import {
  angleToFrequencyCentiHz,
  createDialGestureTrace,
  createDialState,
  frequencyCentiHzToAngle,
  recordDialTraceCommand,
  reduceDialState,
  replayDialGestureTrace,
  stepDialState,
  stepDialStateInPlace,
  validateDialGestureTrace,
} from "./index";

describe("canonical dial engine", () => {
  it("uses browser event milliseconds at the public command boundary", () => {
    expect(GENERATED_DIAL_SPEC.determinism.timestampUnit).toBe("ms");
  });

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

  it("round-trips representative centihertz ticks through the log dial", () => {
    const config = createDialState().config;
    for (const frequencyCentiHz of [
      4_500,
      4_501,
      22_000,
      68_319,
      100_000,
      599_999,
      600_000,
    ]) {
      expect(
        angleToFrequencyCentiHz(
          frequencyCentiHzToAngle(frequencyCentiHz, config),
          config,
        ),
      ).toBe(frequencyCentiHz);
    }
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

  it("keeps every physical input path on safe integer centihertz", () => {
    const expectFixedPointState = (
      state: ReturnType<typeof createDialState>,
    ) => {
      expect(Number.isSafeInteger(state.frequencyCentiHz)).toBe(true);
      expect(
        Number.isSafeInteger(state.previousFrequencyCentiHz),
      ).toBe(true);
      expect(state.frequencyHz).toBe(state.frequencyCentiHz / 100);
      expect(state.previousFrequencyHz).toBe(
        state.previousFrequencyCentiHz / 100,
      );
    };

    let state = createDialState({
      initialFrequencyCentiHz: 68_319,
    });
    expectFixedPointState(state);
    state = reduceDialState(state, {
      type: "pointer-start",
      point: { x: 100, y: 0 },
      center: { x: 0, y: 0 },
      timestampMs: 0,
    });
    expectFixedPointState(state);
    state = reduceDialState(state, {
      type: "pointer-move",
      point: { x: 98, y: 20 },
      center: { x: 0, y: 0 },
      timestampMs: 16,
    });
    expectFixedPointState(state);
    state = reduceDialState(state, {
      type: "pointer-end",
      timestampMs: 17,
    });
    expectFixedPointState(state);
    state = reduceDialState(state, {
      type: "wheel",
      deltaY: -20,
      timestampMs: 32,
    });
    expectFixedPointState(state);
    state = reduceDialState(state, {
      type: "keyboard",
      key: "ArrowRight",
      timestampMs: 48,
    });
    expectFixedPointState(state);
    state = reduceDialState(state, {
      type: "keyboard",
      key: "ArrowLeft",
      timestampMs: 64,
    });
    expectFixedPointState(state);
    state = stepDialState(state, 1 / 60);
    expectFixedPointState(state);
  });

  it("clamps boundaries and fails safely for invalid centihertz commands", () => {
    const initial = createDialState({
      initialFrequencyCentiHz: 68_319,
    });
    const minimum = reduceDialState(initial, {
      type: "set-frequency",
      frequencyCentiHz: Number.MIN_SAFE_INTEGER,
      timestampMs: 16,
    });
    expect(minimum.frequencyCentiHz).toBe(4_500);
    expect(minimum.frequencyHz).toBe(45);

    const maximum = reduceDialState(initial, {
      type: "set-frequency",
      frequencyCentiHz: Number.MAX_SAFE_INTEGER,
      timestampMs: 16,
    });
    expect(maximum.frequencyCentiHz).toBe(600_000);
    expect(maximum.frequencyHz).toBe(6_000);

    const rejectedFraction = reduceDialState(initial, {
      type: "set-frequency",
      frequencyCentiHz: 68_319.5,
      timestampMs: 16,
    });
    expect(rejectedFraction.frequencyCentiHz).toBe(
      initial.frequencyCentiHz,
    );

    for (const invalid of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      const retained = reduceDialState(initial, {
        type: "set-frequency",
        frequencyCentiHz: invalid,
        timestampMs: 16,
      });
      expect(retained.frequencyCentiHz).toBe(
        initial.frequencyCentiHz,
      );
      expect(retained.frequencyHz).toBe(initial.frequencyHz);
      expect(Number.isSafeInteger(retained.frequencyCentiHz)).toBe(
        true,
      );
    }

    const home = reduceDialState(initial, {
      type: "keyboard",
      key: "Home",
      timestampMs: 16,
    });
    const end = reduceDialState(home, {
      type: "keyboard",
      key: "End",
      timestampMs: 32,
    });
    expect(home.frequencyCentiHz).toBe(4_500);
    expect(end.frequencyCentiHz).toBe(600_000);
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

  it("re-anchors through the radial dead zone without an angle jump", () => {
    let state = createDialState({ initialFrequencyHz: 220 });
    state = reduceDialState(state, {
      type: "pointer-start",
      point: { x: 2, y: 2 },
      center: { x: 0, y: 0 },
      deadZoneRadius: 10,
      timestampMs: 0,
    });
    const initialFrequency = state.frequencyHz;
    expect(state.lastPointerAngleRadians).toBeNull();

    state = reduceDialState(state, {
      type: "pointer-move",
      point: { x: 0, y: 100 },
      center: { x: 0, y: 0 },
      deadZoneRadius: 10,
      timestampMs: 16,
    });
    expect(state.frequencyHz).toBe(initialFrequency);

    state = reduceDialState(state, {
      type: "pointer-move",
      point: { x: -20, y: 98 },
      center: { x: 0, y: 0 },
      deadZoneRadius: 10,
      timestampMs: 32,
    });
    expect(state.frequencyHz).toBeGreaterThan(initialFrequency);

    const beforeCrossing = state.frequencyHz;
    state = reduceDialState(state, {
      type: "pointer-move",
      point: { x: 0, y: 0 },
      center: { x: 0, y: 0 },
      deadZoneRadius: 10,
      timestampMs: 48,
    });
    state = reduceDialState(state, {
      type: "pointer-move",
      point: { x: 100, y: 0 },
      center: { x: 0, y: 0 },
      deadZoneRadius: 10,
      timestampMs: 64,
    });
    expect(state.frequencyHz).toBe(beforeCrossing);
  });

  it("unwraps the 0/360 boundary without a frequency discontinuity", () => {
    let state = createDialState({ initialFrequencyHz: 220 });
    state = reduceDialState(state, {
      type: "pointer-start",
      point: { x: -100, y: 1 },
      center: { x: 0, y: 0 },
      deadZoneRadius: 10,
      timestampMs: 0,
    });
    const before = state.frequencyHz;
    state = reduceDialState(state, {
      type: "pointer-move",
      point: { x: -100, y: -1 },
      center: { x: 0, y: 0 },
      deadZoneRadius: 10,
      timestampMs: 16,
    });
    expect(state.frequencyHz).toBeGreaterThan(before);
    expect(
      Math.abs(state.unwrappedAngleRadians - state.effectiveAngleRadians),
    ).toBeLessThan(1e-12);
    expect(
      Math.abs(state.frequencySweepHzPerSecond),
    ).toBeLessThan(1_000);
  });

  it("ignores duplicate and out-of-order pointer samples without re-anchoring", () => {
    let state = createDialState({ initialFrequencyHz: 220 });
    state = reduceDialState(state, {
      type: "pointer-start",
      point: { x: 100, y: 0 },
      center: { x: 0, y: 0 },
      timestampMs: 10,
    });
    state = reduceDialState(state, {
      type: "pointer-move",
      point: { x: 98, y: 20 },
      center: { x: 0, y: 0 },
      timestampMs: 20,
    });
    const accepted = state;
    for (const timestampMs of [20, 19]) {
      state = reduceDialState(state, {
        type: "pointer-move",
        point: { x: -100, y: 0 },
        center: { x: 0, y: 0 },
        timestampMs,
      });
      expect(state).toBe(accepted);
    }
    state = reduceDialState(state, {
      type: "pointer-move",
      point: { x: 92, y: 39 },
      center: { x: 0, y: 0 },
      timestampMs: 30,
    });
    expect(state.frequencyHz).toBeGreaterThan(accepted.frequencyHz);
  });

  it("uses the canonical velocity window and caps release inertia", () => {
    const initial = createDialState({
      initialFrequencyCentiHz: 22_000,
      config: {
        velocityHistoryWindowSeconds: 0.12,
        maximumInitialInertiaVelocity: 0.5,
      },
    });
    let state = reduceDialState(initial, {
      type: "pointer-start",
      point: { x: 100, y: 0 },
      center: { x: 0, y: 0 },
      timestampMs: 0,
    });
    state = reduceDialState(state, {
      type: "pointer-move",
      point: { x: 98, y: 20 },
      center: { x: 0, y: 0 },
      timestampMs: 16,
    });
    expect(state.angularVelocityRadiansPerSecond).toBeGreaterThan(0);
    expect(state.angularVelocityRadiansPerSecond).toBeLessThan(4);
    state = reduceDialState(state, {
      type: "pointer-end",
      timestampMs: 17,
    });
    expect(state.angularVelocityRadiansPerSecond).toBeLessThanOrEqual(0.5);
  });

  it("expires stale pointer velocity while a held dial is stationary", () => {
    const beginGesture = () => {
      let state = reduceDialState(
        createDialState({ initialFrequencyHz: 220 }),
        {
          type: "pointer-start",
          point: { x: 100, y: 0 },
          center: { x: 0, y: 0 },
          timestampMs: 0,
        },
      );
      state = reduceDialState(state, {
        type: "pointer-move",
        point: { x: 98, y: 20 },
        center: { x: 0, y: 0 },
        timestampMs: 16,
      });
      expect(state.angularVelocityRadiansPerSecond).toBeGreaterThan(0);
      return state;
    };

    let immutable = beginGesture();
    const mutable = beginGesture();
    const heldFrequency = immutable.frequencyHz;
    for (let index = 0; index < 12; index += 1) {
      immutable = stepDialState(immutable, 0.05);
      stepDialStateInPlace(mutable, 0.05);
    }

    expect(mutable).toEqual(immutable);
    expect(immutable.frequencyHz).toBe(heldFrequency);
    expect(immutable.frequencySweepHzPerSecond).toBe(0);
    expect(immutable.angularVelocityRadiansPerSecond).toBe(0);
    expect(immutable.direction).toBe(0);
    expect(immutable.stoppedSeconds).toBeCloseTo(0.6, 12);

    const released = reduceDialState(immutable, {
      type: "pointer-end",
      timestampMs: 616,
    });
    const afterRelease = stepDialState(released, 0.1);
    expect(released.angularVelocityRadiansPerSecond).toBe(0);
    expect(afterRelease.unwrappedAngleRadians).toBe(
      released.unwrappedAngleRadians,
    );

    const releasedWithoutRaf = reduceDialState(beginGesture(), {
      type: "pointer-end",
      timestampMs: 616,
    });
    expect(releasedWithoutRaf.angularVelocityRadiansPerSecond).toBe(0);
    expect(releasedWithoutRaf.frequencySweepHzPerSecond).toBe(0);
  });

  it("distinguishes fast, slow, and reversing pointer velocity", () => {
    const pointAt = (angleRadians: number) => ({
      x: Math.cos(angleRadians) * 100,
      y: Math.sin(angleRadians) * 100,
    });
    const velocityAfter = (elapsedMilliseconds: number) => {
      let state = reduceDialState(
        createDialState({ initialFrequencyHz: 220 }),
        {
          type: "pointer-start",
          point: pointAt(0),
          center: { x: 0, y: 0 },
          timestampMs: 0,
        },
      );
      state = reduceDialState(state, {
        type: "pointer-move",
        point: pointAt(0.2),
        center: { x: 0, y: 0 },
        timestampMs: elapsedMilliseconds,
      });
      return state.angularVelocityRadiansPerSecond;
    };

    const fastVelocity = velocityAfter(16);
    const slowVelocity = velocityAfter(80);
    expect(fastVelocity).toBeGreaterThan(slowVelocity);
    expect(slowVelocity).toBeGreaterThan(0);

    let reversing = reduceDialState(
      createDialState({ initialFrequencyHz: 220 }),
      {
        type: "pointer-start",
        point: pointAt(0),
        center: { x: 0, y: 0 },
        timestampMs: 0,
      },
    );
    reversing = reduceDialState(reversing, {
      type: "pointer-move",
      point: pointAt(0.2),
      center: { x: 0, y: 0 },
      timestampMs: 16,
    });
    reversing = reduceDialState(reversing, {
      type: "pointer-move",
      point: pointAt(-0.3),
      center: { x: 0, y: 0 },
      timestampMs: 32,
    });

    expect(reversing.angularVelocityRadiansPerSecond).toBeLessThan(0);
    expect(reversing.frequencySweepHzPerSecond).toBeLessThan(0);
    expect(reversing.direction).toBe(-1);
  });

  it("restores an overscrolled end stop even after inertia duration expires", () => {
    let state = createDialState({
      initialFrequencyHz: 6_000,
      config: {
        inertiaMaximumDurationSeconds: 0,
        endStopStiffness: 40,
        endStopDamping: 12,
      },
    });
    state = reduceDialState(state, {
      type: "nudge",
      deltaRadians: 2,
      timestampMs: 1,
    });
    expect(state.unwrappedAngleRadians).toBeGreaterThan(
      state.config.maxAngleRadians,
    );
    for (let index = 0; index < 1_200; index += 1) {
      state = stepDialState(state, 1 / 240);
    }
    expect(state.unwrappedAngleRadians).toBeLessThanOrEqual(
      state.config.maxAngleRadians + 1e-6,
    );
    expect(state.frequencyHz).toBeCloseTo(6_000, 8);
  });

  it("keeps immutable history isolated from the allocation-free tick", () => {
    const initial = reduceDialState(
      createDialState({ initialFrequencyHz: 220 }),
      {
        type: "nudge",
        deltaRadians: 0.5,
        timestampMs: 16,
      },
    );
    const immutableNext = stepDialState(initial, 1 / 60);
    const retainedInitial = JSON.stringify(initial);
    const inPlaceReference = immutableNext;
    stepDialStateInPlace(inPlaceReference, 1 / 60);

    expect(JSON.stringify(initial)).toBe(retainedInitial);
    expect(inPlaceReference).toBe(immutableNext);

    let immutable = reduceDialState(
      createDialState({ initialFrequencyHz: 220 }),
      {
        type: "nudge",
        deltaRadians: 0.5,
        timestampMs: 16,
      },
    );
    const mutable = reduceDialState(
      createDialState({ initialFrequencyHz: 220 }),
      {
        type: "nudge",
        deltaRadians: 0.5,
        timestampMs: 16,
      },
    );
    for (let index = 0; index < 120; index += 1) {
      immutable = stepDialState(immutable, 1 / 120);
      stepDialStateInPlace(mutable, 1 / 120);
    }
    expect(mutable).toEqual(immutable);
  });

  it("records and replays a deterministic gesture trace", () => {
    let trace = createDialGestureTrace({
      traceId: "centihertz-v2-history",
      initialFrequencyCentiHz: 68_319,
      durationSeconds: 0.3,
    });
    trace = recordDialTraceCommand(trace, 0.05, {
      type: "keyboard",
      key: "ArrowRight",
      timestampMs: 99_999,
    });
    trace = recordDialTraceCommand(trace, 0.1, {
      type: "keyboard",
      key: "ArrowLeft",
      timestampMs: 88_888,
    });
    trace = recordDialTraceCommand(trace, 0.15, {
      type: "set-frequency",
      frequencyCentiHz: 68_325,
      timestampMs: 77_777,
    });

    expect(validateDialGestureTrace(trace)).toEqual([]);
    const serialized = JSON.stringify(trace);
    expect(serialized).toContain(
      '"schemaVersion":"mandelhowl.dial-gesture-trace.v2"',
    );
    expect(serialized).toContain('"initialFrequencyCentiHz":68319');
    expect(serialized).not.toContain('"precision"');
    expect(serialized).not.toContain("initialFrequencyHz");

    const first = replayDialGestureTrace(trace);
    const second = replayDialGestureTrace(trace);
    expect(first.finalState).toEqual(second.finalState);
    expect(
      first.eventStates.every(({ frequencyCentiHz }) =>
        Number.isSafeInteger(frequencyCentiHz),
      ),
    ).toBe(true);
    expect(first.finalState.frequencyCentiHz).toBe(68_325);
    expect(first.finalState.frequencyHz).toBe(683.25);
    expect(first.eventStates).toHaveLength(3);
  });
});
