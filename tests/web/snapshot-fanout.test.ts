import { describe, expect, it, vi } from "vitest";
import type { RuntimeSnapshot } from "../../packages/contracts/src";
import {
  advanceMandelHowlRuntime,
  createMandelHowlRuntime,
  createRuntimeSnapshotWriter,
  getRuntimeSnapshot,
} from "../../packages/resonance-engine/src";
import {
  RuntimeSnapshotFanout,
  RuntimeSnapshotLeaseFanout,
  RuntimeSnapshotStore,
} from "../../packages/browser-runtime/src";

function snapshot(
  sequence: number,
  datasetId = `sha256:${"0".repeat(64)}`,
): RuntimeSnapshot {
  return {
    schemaVersion: "mandelhowl.runtime-snapshot.v1",
    unitSystem: "SI",
    datasetId: datasetId as `sha256:${string}`,
    sequence,
    simulationStep: sequence,
    simulationTimeSeconds: sequence / 240,
    dial: {
      unwrappedAngleRad: 0,
      angularVelocityRadPerSecond: 0,
      driveFrequencyHz: 220,
      previousDriveFrequencyHz: 220,
      sweepRateHzPerSecond: 0,
      approachDirection: "stationary",
      stationaryTimeSeconds: 1,
      atMinimumEndStop: false,
      atMaximumEndStop: false,
    },
    modes: [],
    activeModeId: null,
    microphone: {
      rmsNormalized: 0,
      peakNormalized: 0,
      recentSamples: [],
    },
    feedback: {
      envelopeNormalized: 0,
      loopSignalNormalized: 0,
      limiterGainReductionDb: 0,
      limiterActive: false,
    },
    regime: "decaying",
    volume: {
      status: "settled",
      value: 0,
      lastSettledValue: 0,
      progress: 1,
    },
    diagnostics: [],
  };
}

describe("RuntimeSnapshotFanout", () => {
  it("passes the exact same object to all consumers once", () => {
    const first = vi.fn();
    const second = vi.fn();
    const fanout = new RuntimeSnapshotFanout([first, second]);
    const frame = snapshot(1);

    expect(fanout.publish(frame)).toBe(true);
    expect(first).toHaveBeenCalledWith(frame);
    expect(second).toHaveBeenCalledWith(frame);
    expect(first.mock.calls[0][0]).toBe(second.mock.calls[0][0]);
    expect(fanout.metrics.consumerCount).toBe(2);
  });

  it("rejects duplicate or out-of-order frames", () => {
    const consumer = vi.fn();
    const fanout = new RuntimeSnapshotFanout([consumer]);

    expect(fanout.publish(snapshot(2))).toBe(true);
    expect(fanout.publish(snapshot(2))).toBe(false);
    expect(fanout.publish(snapshot(1))).toBe(false);
    expect(consumer).toHaveBeenCalledTimes(1);
    expect(fanout.metrics.rejectedFrames).toBe(2);
  });

  it("drops all consumer references on dispose", () => {
    const fanout = new RuntimeSnapshotFanout([vi.fn()]);
    fanout.dispose();
    expect(fanout.metrics.consumerCount).toBe(0);
    expect(fanout.publish(snapshot(1))).toBe(false);
  });

  it("accepts a reset sequence when a verified dataset replaces fallback", () => {
    const consumer = vi.fn();
    const fanout = new RuntimeSnapshotFanout([consumer]);
    expect(fanout.publish(snapshot(12))).toBe(true);
    expect(
      fanout.publish(snapshot(0, `sha256:${"1".repeat(64)}`)),
    ).toBe(true);
    expect(consumer).toHaveBeenCalledTimes(2);
  });

  it("continues after both a consumer and its error observer fail", () => {
    const laterConsumer = vi.fn();
    let shouldFail = true;
    const failingConsumer = () => {
      if (shouldFail) throw new Error("consumer failed");
    };
    const errors = vi.fn(() => {
      throw new Error("observer failed");
    });
    const fanout = new RuntimeSnapshotFanout(
      [failingConsumer, laterConsumer],
      errors,
    );

    expect(fanout.publish(snapshot(1))).toBe(true);
    expect(fanout.publish(snapshot(2))).toBe(true);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(laterConsumer).toHaveBeenCalledTimes(2);

    shouldFail = false;
    expect(fanout.publish(snapshot(3))).toBe(true);
    shouldFail = true;
    expect(fanout.publish(snapshot(4))).toBe(true);
    expect(errors).toHaveBeenCalledTimes(2);
    expect(laterConsumer).toHaveBeenCalledTimes(4);
  });
});

describe("RuntimeSnapshotStore", () => {
  it("implements the immediate readable-store contract for React and Svelte", () => {
    const initial = snapshot(0);
    const store = new RuntimeSnapshotStore(initial);
    const subscriber = vi.fn();
    const unsubscribe = store.subscribe(subscriber);

    expect(subscriber).toHaveBeenCalledWith(initial);
    expect(store.getSnapshot()).toBe(initial);

    const next = snapshot(1);
    expect(store.publish(next)).toBe(true);
    expect(subscriber).toHaveBeenLastCalledWith(next);
    expect(store.getSnapshot()).toBe(next);

    unsubscribe();
    expect(store.metrics.consumerCount).toBe(0);
  });

  it("commits before notification and retains reentrant initial publications", () => {
    const initial = snapshot(0);
    const next = snapshot(1);
    const store = new RuntimeSnapshotStore(initial);
    const observed: number[] = [];

    const unsubscribe = store.subscribe((value) => {
      observed.push(value.sequence);
      expect(store.getSnapshot()).toBe(value);
      if (value === initial) {
        expect(store.publish(next)).toBe(true);
      }
    });

    expect(observed).toEqual([0, 1]);
    expect(store.getSnapshot()).toBe(next);
    expect(store.metrics.publishedFrames).toBe(1);
    unsubscribe();
  });

  it("removes an initial subscriber that throws before subscribe returns", () => {
    const errorObserver = vi.fn();
    const failingSubscriber = vi.fn(() => {
      throw new Error("initial delivery failed");
    });
    const store = new RuntimeSnapshotStore(
      snapshot(0),
      [],
      errorObserver,
    );

    const unsubscribe = store.subscribe(failingSubscriber);
    expect(failingSubscriber).toHaveBeenCalledTimes(1);
    expect(errorObserver).toHaveBeenCalledTimes(1);
    expect(store.metrics.consumerCount).toBe(0);

    expect(store.publish(snapshot(1))).toBe(true);
    expect(failingSubscriber).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});

describe("RuntimeSnapshotLeaseFanout", () => {
  it("synchronously gives renderer and audio the same reusable lease", () => {
    let runtime = createMandelHowlRuntime({
      initialFrequencyHz: 220,
    });
    const writer = createRuntimeSnapshotWriter();
    const renderer = vi.fn();
    const audio = vi.fn();
    const hotPath = new RuntimeSnapshotLeaseFanout([renderer, audio]);
    const presentation = new RuntimeSnapshotFanout();

    const lease = writer.write(runtime);
    const owned = getRuntimeSnapshot(runtime);
    expect(hotPath.publish(lease)).toBe(true);
    expect(presentation.publish(owned)).toBe(true);

    expect(renderer.mock.calls[0]?.[0]).toBe(audio.mock.calls[0]?.[0]);
    expect(renderer.mock.calls[0]?.[0]).toBe(lease);
    expect(lease).toEqual(owned);
    expect(lease.sequence).toBe(owned.sequence);
    expect(hotPath.metrics.consumerCount).toBe(2);
    expect(presentation.metrics.consumerCount).toBe(0);

    const retainedPresentationSequence = owned.sequence;
    runtime = advanceMandelHowlRuntime(runtime, 1 / 60);
    const nextLease = writer.write(runtime);
    expect(nextLease).toBe(lease);
    expect(lease.sequence).toBeGreaterThan(retainedPresentationSequence);
    expect(owned.sequence).toBe(retainedPresentationSequence);
  });

  it("isolates a failed hot-path consumer and never retains subscribers", () => {
    const laterConsumer = vi.fn();
    let shouldFail = true;
    const failingConsumer = () => {
      if (shouldFail) throw new Error("renderer failed");
    };
    const errors = vi.fn(() => {
      throw new Error("observer failed");
    });
    const hotPath = new RuntimeSnapshotLeaseFanout(
      [failingConsumer, laterConsumer],
      errors,
    );
    const writer = createRuntimeSnapshotWriter();
    let runtime = createMandelHowlRuntime({
      initialFrequencyHz: 220,
    });

    expect(hotPath.publish(writer.write(runtime))).toBe(true);
    runtime = advanceMandelHowlRuntime(runtime, 1 / 60);
    expect(hotPath.publish(writer.write(runtime))).toBe(true);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(laterConsumer).toHaveBeenCalledTimes(2);

    shouldFail = false;
    runtime = advanceMandelHowlRuntime(runtime, 1 / 60);
    expect(hotPath.publish(writer.write(runtime))).toBe(true);
    shouldFail = true;
    runtime = advanceMandelHowlRuntime(runtime, 1 / 60);
    expect(hotPath.publish(writer.write(runtime))).toBe(true);
    expect(errors).toHaveBeenCalledTimes(2);
    expect(laterConsumer).toHaveBeenCalledTimes(4);
    expect(hotPath.metrics.consumerCount).toBe(2);

    hotPath.dispose();
    expect(hotPath.metrics.consumerCount).toBe(0);
    expect(hotPath.publish(writer.write(runtime))).toBe(false);
  });
});
