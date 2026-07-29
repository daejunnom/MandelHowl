import { describe, expect, it, vi } from "vitest";
import type { RuntimeSnapshot } from "../../packages/contracts/src";
import { RuntimeSnapshotFanout } from "../../app/snapshot-fanout";

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
});
