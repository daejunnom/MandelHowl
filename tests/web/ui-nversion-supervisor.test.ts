import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  MandelHowlBrowserRuntimePort,
  MandelHowlUiSnapshot,
  UiNVersionDefinition,
  UiNVersionImplementation,
  UiViewMountContext,
} from "../../packages/browser-runtime/src";
import { UiNVersionSupervisor } from "../../packages/browser-runtime/src";
import type { DiagnosticRecord, RuntimeSnapshot } from "../../packages/contracts/src";

const SCIENTIFIC_DIGEST = `sha256:${"1".repeat(64)}`;
const PRESENTATION_DIGEST = `sha256:${"2".repeat(64)}`;

function runtimeSnapshot(sequence = 0): RuntimeSnapshot {
  return {
    schemaVersion: "mandelhowl.runtime-snapshot.v1",
    unitSystem: "SI",
    datasetId: `sha256:${"0".repeat(64)}`,
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

function uiSnapshot(runtime = runtimeSnapshot()): MandelHowlUiSnapshot {
  return {
    contractVersion: "mandelhowl.ui-port.v1",
    revision: 0,
    runtime,
    minimumFrequencyHz: 45,
    maximumFrequencyHz: 6_000,
    radialDeadZone: 0.2,
    dragging: false,
    audioEnabled: false,
    datasetStatus: "prototype",
    renderer: null,
    diagnostic: {
      severity: "none",
      title: null,
      message: null,
      code: null,
      detail: null,
    },
    challengeTarget: null,
  };
}

function readable<T>(value: T): {
  getSnapshot(): T;
  subscribe(consumer: (next: T) => void): () => void;
} {
  return {
    getSnapshot: () => value,
    subscribe: (consumer) => {
      consumer(value);
      return () => {};
    },
  };
}

function runtimePort() {
  const runtime = runtimeSnapshot();
  const detachPlate = vi.fn();
  const port: MandelHowlBrowserRuntimePort = {
    contractVersion: "mandelhowl.ui-port.v1",
    snapshots: readable(runtime),
    presentation: readable(uiSnapshot(runtime)),
    mountPlate: vi.fn(() => ({ detach: detachPlate })),
    dispatchDial: vi.fn(),
    setDragging: vi.fn(),
    activateAudio: vi.fn(async () => true),
  };
  return { port, detachPlate };
}

function implementation(
  id: "svelte5" | "react",
  mount: UiNVersionImplementation["mount"],
  scientificAlgorithmDigest = SCIENTIFIC_DIGEST,
  presentationContractDigest = PRESENTATION_DIGEST,
): UiNVersionImplementation {
  return {
    id,
    scientificAlgorithmDigest,
    presentationContractDigest,
    mount,
  };
}

function definition(
  id: "svelte5" | "react",
  value: UiNVersionImplementation | Error,
  scientificAlgorithmDigest = SCIENTIFIC_DIGEST,
  presentationContractDigest = PRESENTATION_DIGEST,
): UiNVersionDefinition {
  return {
    id,
    scientificAlgorithmDigest,
    presentationContractDigest,
    load: vi.fn(async () => {
      if (value instanceof Error) throw value;
      return value;
    }),
  };
}

function supervisor(
  port: MandelHowlBrowserRuntimePort,
  primary: UiNVersionDefinition & { id: "svelte5" },
  standby: UiNVersionDefinition & { id: "react" },
  diagnostics: DiagnosticRecord[],
  timeoutMs = 100,
): UiNVersionSupervisor {
  return new UiNVersionSupervisor(port, {
    primary,
    standby,
    expectedScientificAlgorithmDigest: SCIENTIFIC_DIGEST,
    expectedPresentationContractDigest: PRESENTATION_DIGEST,
    readinessTimeoutMs: timeoutMs,
    heartbeatTimeoutMs: timeoutMs,
    onDiagnostic: (record) => diagnostics.push(record),
  });
}

async function flushTransitions(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

interface FakeDomNode {
  readonly ownerDocument: {
    createElement(tagName: string): FakeDomNode;
  };
  readonly dataset: Record<string, string>;
  className: string;
  parent: FakeDomNode | null;
  children: FakeDomNode[];
  replaceChildren(...children: FakeDomNode[]): void;
  remove(): void;
}

function createFakeDomHost(): FakeDomNode {
  const ownerDocument = {
    createElement: () => createNode(),
  };
  const createNode = (): FakeDomNode => ({
    ownerDocument,
    dataset: {},
    className: "",
    parent: null,
    children: [],
    replaceChildren(...children: FakeDomNode[]) {
      for (const child of this.children) child.parent = null;
      this.children = children;
      for (const child of children) child.parent = this;
    },
    remove() {
      if (!this.parent) return;
      this.parent.children = this.parent.children.filter(
        (child) => child !== this,
      );
      this.parent = null;
    },
  });
  return createNode();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("UiNVersionSupervisor", () => {
  it("mounts Svelte as the only active primary when it is healthy", async () => {
    const { port } = runtimePort();
    const primaryDetach = vi.fn();
    const primary = definition(
      "svelte5",
      implementation("svelte5", (context) => {
        context.reportReady();
        context.reportHeartbeat(0);
        return { detachView: primaryDetach };
      }),
    ) as UiNVersionDefinition & { id: "svelte5" };
    const standby = definition(
      "react",
      implementation("react", () => ({ detachView: vi.fn() })),
    ) as UiNVersionDefinition & { id: "react" };
    const diagnostics: DiagnosticRecord[] = [];
    const host = supervisor(port, primary, standby, diagnostics);

    await expect(host.start({} as HTMLElement)).resolves.toMatchObject({
      phase: "active",
      activeImplementationId: "svelte5",
      activeRole: "primary",
      generation: 1,
      failoverCount: 0,
      lastHeartbeatSequence: 0,
    });
    expect(primary.load).toHaveBeenCalledTimes(1);
    expect(standby.load).not.toHaveBeenCalled();
    expect(diagnostics).toEqual([]);

    host.disposeView();
    expect(primaryDetach).toHaveBeenCalledTimes(1);
    expect(host.getSnapshot().phase).toBe("disposed");
  });

  it("uses React exactly once after a primary availability failure", async () => {
    const { port } = runtimePort();
    const diagnostics: DiagnosticRecord[] = [];
    const primary = definition(
      "svelte5",
      new Error("chunk unavailable"),
    ) as UiNVersionDefinition & { id: "svelte5" };
    const standby = definition(
      "react",
      implementation("react", (context) => {
        context.reportReady();
        return { detachView: vi.fn() };
      }),
    ) as UiNVersionDefinition & { id: "react" };
    const host = supervisor(port, primary, standby, diagnostics);

    await expect(host.start({} as HTMLElement)).resolves.toMatchObject({
      phase: "active",
      activeImplementationId: "react",
      activeRole: "standby",
      failoverCount: 1,
      generation: 2,
    });
    expect(diagnostics.map((record) => record.code)).toEqual([
      "MH-UI-PRIMARY-LOAD-FAILED",
      "MH-UI-FAILOVER-ACTIVATED",
    ]);
    expect(primary.load).toHaveBeenCalledTimes(1);
    expect(standby.load).toHaveBeenCalledTimes(1);
  });

  it("contains a synchronous lazy-loader throw and still selects React", async () => {
    const { port } = runtimePort();
    const diagnostics: DiagnosticRecord[] = [];
    const primary: UiNVersionDefinition & { id: "svelte5" } = {
      id: "svelte5",
      scientificAlgorithmDigest: SCIENTIFIC_DIGEST,
      presentationContractDigest: PRESENTATION_DIGEST,
      load: vi.fn(() => {
        throw new Error("synchronous chunk loader failure");
      }),
    };
    const standby = definition(
      "react",
      implementation("react", (context) => {
        context.reportReady();
        return { detachView: vi.fn() };
      }),
    ) as UiNVersionDefinition & { id: "react" };
    const host = supervisor(port, primary, standby, diagnostics);

    await expect(host.start({} as HTMLElement)).resolves.toMatchObject({
      phase: "active",
      activeImplementationId: "react",
      activeRole: "standby",
      failoverCount: 1,
    });
    expect(diagnostics.map((record) => record.code)).toEqual([
      "MH-UI-PRIMARY-LOAD-FAILED",
      "MH-UI-FAILOVER-ACTIVATED",
    ]);
  });

  it("classifies a synchronous primary mount throw and activates React", async () => {
    const { port } = runtimePort();
    const diagnostics: DiagnosticRecord[] = [];
    const primary = definition(
      "svelte5",
      implementation("svelte5", () => {
        throw new Error("framework mount failed synchronously");
      }),
    ) as UiNVersionDefinition & { id: "svelte5" };
    const standby = definition(
      "react",
      implementation("react", (context) => {
        context.reportReady();
        context.reportHeartbeat(0);
        return { detachView: vi.fn() };
      }),
    ) as UiNVersionDefinition & { id: "react" };
    const host = supervisor(port, primary, standby, diagnostics);

    await expect(host.start({} as HTMLElement)).resolves.toMatchObject({
      phase: "active",
      activeImplementationId: "react",
      activeRole: "standby",
      failoverCount: 1,
    });
    expect(diagnostics.map((record) => record.code)).toEqual([
      "MH-UI-PRIMARY-MOUNT-FAILED",
      "MH-UI-FAILOVER-ACTIVATED",
    ]);
  });

  it("revokes the old input generation and suppresses replayed event ids", async () => {
    const { port } = runtimePort();
    const diagnostics: DiagnosticRecord[] = [];
    let primaryContext: UiViewMountContext | null = null;
    let standbyContext: UiViewMountContext | null = null;
    const primary = definition(
      "svelte5",
      implementation("svelte5", (context) => {
        primaryContext = context;
        context.reportReady();
        return { detachView: vi.fn() };
      }),
    ) as UiNVersionDefinition & { id: "svelte5" };
    const standby = definition(
      "react",
      implementation("react", (context) => {
        standbyContext = context;
        context.reportReady();
        return { detachView: vi.fn() };
      }),
    ) as UiNVersionDefinition & { id: "react" };
    const host = supervisor(port, primary, standby, diagnostics);
    await host.start({} as HTMLElement);

    const firstContext = primaryContext as unknown as UiViewMountContext;
    expect(
      firstContext.runtime.dispatchDial(
        { type: "keyboard", key: "ArrowUp", timestampMs: 1 },
        "keyboard:1",
      ),
    ).toBe(true);
    expect(
      firstContext.runtime.dispatchDial(
        { type: "keyboard", key: "ArrowUp", timestampMs: 1 },
        "keyboard:1",
      ),
    ).toBe(false);

    firstContext.reportAvailabilityFailure("view", new Error("view crashed"));
    await flushTransitions();
    expect(host.getSnapshot()).toMatchObject({
      phase: "active",
      activeImplementationId: "react",
      generation: 2,
    });

    const secondContext = standbyContext as unknown as UiViewMountContext;
    expect(
      firstContext.runtime.dispatchDial(
        { type: "keyboard", key: "ArrowDown", timestampMs: 2 },
        "keyboard:2",
      ),
    ).toBe(false);
    expect(
      secondContext.runtime.dispatchDial(
        { type: "keyboard", key: "ArrowUp", timestampMs: 1 },
        "keyboard:1",
      ),
    ).toBe(false);
    expect(
      secondContext.runtime.dispatchDial(
        { type: "keyboard", key: "ArrowDown", timestampMs: 2 },
        "keyboard:2",
      ),
    ).toBe(true);
    expect(port.dispatchDial).toHaveBeenCalledTimes(2);
    expect(diagnostics.map((record) => record.code)).toContain(
      "MH-UI-DUPLICATE-INPUT-REJECTED",
    );
    expect(diagnostics.map((record) => record.code)).toContain(
      "MH-UI-STALE-INPUT-REJECTED",
    );
  });

  it("rejects internal dial-engine commands at the framework lease boundary", async () => {
    const { port } = runtimePort();
    const diagnostics: DiagnosticRecord[] = [];
    let primaryContext: UiViewMountContext | null = null;
    const primary = definition(
      "svelte5",
      implementation("svelte5", (context) => {
        primaryContext = context;
        context.reportReady();
        return { detachView: vi.fn() };
      }),
    ) as UiNVersionDefinition & { id: "svelte5" };
    const standby = definition(
      "react",
      implementation("react", () => ({ detachView: vi.fn() })),
    ) as UiNVersionDefinition & { id: "react" };
    const host = supervisor(port, primary, standby, diagnostics);
    await host.start({} as HTMLElement);

    const context = primaryContext as unknown as UiViewMountContext;
    expect(
      context.runtime.dispatchDial(
        { type: "nudge", deltaRadians: 1, timestampMs: 1 },
        "nudge:1",
      ),
    ).toBe(false);
    expect(
      context.runtime.dispatchDial(
        { type: "set-frequency", frequencyHz: 440, timestampMs: 2 },
        "set-frequency:2",
      ),
    ).toBe(false);
    expect(
      context.runtime.dispatchDial(
        { type: "advance", deltaSeconds: 1 },
        "advance:3",
      ),
    ).toBe(false);
    expect(
      context.runtime.dispatchDial(
        { type: "reset", frequencyHz: 440 },
        "reset:4",
      ),
    ).toBe(false);
    expect(context.runtime.setDragging(true, "synthetic-drag:5")).toBe(false);

    expect(port.dispatchDial).not.toHaveBeenCalled();
    expect(port.setDragging).not.toHaveBeenCalled();
    expect(diagnostics.map((record) => record.code)).toContain(
      "MH-UI-FORBIDDEN-COMMAND-REJECTED",
    );
    expect(diagnostics.map((record) => record.code)).toContain(
      "MH-UI-INCONSISTENT-DRAGGING-REJECTED",
    );
  });

  it("keeps captured pointer ownership when keyboard or wheel input overlaps", async () => {
    const { port } = runtimePort();
    const diagnostics: DiagnosticRecord[] = [];
    let primaryContext: UiViewMountContext | null = null;
    const primary = definition(
      "svelte5",
      implementation("svelte5", (context) => {
        primaryContext = context;
        context.reportReady();
        return { detachView: vi.fn() };
      }),
    ) as UiNVersionDefinition & { id: "svelte5" };
    const standby = definition(
      "react",
      implementation("react", () => ({ detachView: vi.fn() })),
    ) as UiNVersionDefinition & { id: "react" };
    const host = supervisor(port, primary, standby, diagnostics);
    await host.start({} as HTMLElement);

    const context = primaryContext as unknown as UiViewMountContext;
    expect(
      context.runtime.dispatchDial(
        {
          type: "pointer-start",
          point: { x: 10, y: 0 },
          center: { x: 0, y: 0 },
          timestampMs: 10,
        },
        "pointer-start:10",
      ),
    ).toBe(true);
    expect(context.runtime.setDragging(true, "pointer-start:10")).toBe(true);
    expect(
      context.runtime.dispatchDial(
        { type: "keyboard", key: "ArrowUp", timestampMs: 11 },
        "keyboard:11",
      ),
    ).toBe(false);
    expect(
      context.runtime.dispatchDial(
        { type: "wheel", deltaY: -10, timestampMs: 12 },
        "wheel:12",
      ),
    ).toBe(false);
    expect(
      context.runtime.dispatchDial(
        { type: "pointer-end", timestampMs: 13 },
        "pointer-end:13",
      ),
    ).toBe(true);
    expect(context.runtime.setDragging(false, "pointer-end:13")).toBe(true);

    expect(port.dispatchDial).toHaveBeenCalledTimes(2);
    expect(port.dispatchDial).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ type: "pointer-start" }),
    );
    expect(port.dispatchDial).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ type: "pointer-end" }),
    );
    expect(port.setDragging).toHaveBeenNthCalledWith(1, true);
    expect(port.setDragging).toHaveBeenNthCalledWith(2, false);
    expect(diagnostics.map((record) => record.code)).toContain(
      "MH-UI-CONFLICTING-INPUT-REJECTED",
    );
  });

  it("cancels a primary-owned pointer gesture exactly once before standby activation", async () => {
    const { port } = runtimePort();
    let primaryContext: UiViewMountContext | null = null;
    const primary = definition(
      "svelte5",
      implementation("svelte5", (context) => {
        primaryContext = context;
        context.reportReady();
        return { detachView: vi.fn() };
      }),
    ) as UiNVersionDefinition & { id: "svelte5" };
    const standby = definition(
      "react",
      implementation("react", (context) => {
        context.reportReady();
        return { detachView: vi.fn() };
      }),
    ) as UiNVersionDefinition & { id: "react" };
    const host = supervisor(port, primary, standby, []);
    await host.start({} as HTMLElement);

    const context = primaryContext as unknown as UiViewMountContext;
    expect(
      context.runtime.dispatchDial(
        {
          type: "pointer-start",
          point: { x: 10, y: 20 },
          center: { x: 0, y: 0 },
          timestampMs: 10,
        },
        "pointer-start:10",
      ),
    ).toBe(true);
    expect(context.runtime.setDragging(true, "pointer-start:10")).toBe(true);

    context.reportAvailabilityFailure("view", new Error("pointer view failed"));
    await flushTransitions();

    expect(host.getSnapshot()).toMatchObject({
      phase: "active",
      activeImplementationId: "react",
    });
    expect(port.dispatchDial).toHaveBeenCalledTimes(2);
    expect(port.dispatchDial).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "pointer-cancel" }),
    );
    expect(port.setDragging).toHaveBeenNthCalledWith(1, true);
    expect(port.setDragging).toHaveBeenNthCalledWith(2, false);
  });

  it("isolates a timed-out async mount in a disconnected generation target", async () => {
    vi.useFakeTimers();
    const { port } = runtimePort();
    const root = createFakeDomHost();
    let primaryTarget: FakeDomNode | null = null;
    let standbyTarget: FakeDomNode | null = null;
    let resolveLateMount:
      | ((view: { detachView(): void }) => void)
      | null = null;
    const lateDetach = vi.fn();
    const primary = definition(
      "svelte5",
      implementation("svelte5", (context) => {
        primaryTarget = context.target as unknown as FakeDomNode;
        return new Promise((resolve) => {
          resolveLateMount = resolve;
        });
      }),
    ) as UiNVersionDefinition & { id: "svelte5" };
    const standby = definition(
      "react",
      implementation("react", (context) => {
        standbyTarget = context.target as unknown as FakeDomNode;
        context.reportReady();
        return { detachView: vi.fn() };
      }),
    ) as UiNVersionDefinition & { id: "react" };
    const host = supervisor(port, primary, standby, [], 50);

    const starting = host.start(root as unknown as HTMLElement);
    await flushTransitions();
    expect(root.children).toEqual([primaryTarget]);
    await vi.advanceTimersByTimeAsync(51);
    await starting;

    expect(primaryTarget).not.toBe(standbyTarget);
    expect((primaryTarget as unknown as FakeDomNode).parent).toBeNull();
    expect(root.children).toEqual([standbyTarget]);

    const resolveMount = resolveLateMount as unknown as (
      view: { detachView(): void },
    ) => void;
    resolveMount({ detachView: lateDetach });
    await flushTransitions();
    expect(lateDetach).toHaveBeenCalledTimes(1);
    expect(root.children).toEqual([standbyTarget]);
  });

  it("promotes an attachment availability signal and unsubscribes it on failover", async () => {
    const { port, detachPlate } = runtimePort();
    let emitAvailabilityFailure: ((error: unknown) => void) | null = null;
    const unsubscribeAvailabilityFailure = vi.fn();
    port.mountPlate = vi.fn(() => ({
      detach: detachPlate,
      subscribeAvailabilityFailure(consumer: (error: unknown) => void) {
        emitAvailabilityFailure = consumer;
        return unsubscribeAvailabilityFailure;
      },
    }));
    const primary = definition(
      "svelte5",
      implementation("svelte5", (context) => {
        context.runtime.mountPlate({} as HTMLCanvasElement);
        context.reportReady();
        return { detachView: vi.fn() };
      }),
    ) as UiNVersionDefinition & { id: "svelte5" };
    const standby = definition(
      "react",
      implementation("react", (context) => {
        context.reportReady();
        return { detachView: vi.fn() };
      }),
    ) as UiNVersionDefinition & { id: "react" };
    const host = supervisor(port, primary, standby, []);
    await host.start({} as HTMLElement);

    const emit = emitAvailabilityFailure as unknown as (
      error: unknown,
    ) => void;
    emit(new Error("view renderer unavailable"));
    await flushTransitions();

    expect(host.getSnapshot()).toMatchObject({
      phase: "active",
      activeImplementationId: "react",
      failoverCount: 1,
    });
    expect(unsubscribeAvailabilityFailure).toHaveBeenCalledTimes(1);
    expect(detachPlate).toHaveBeenCalledTimes(1);
  });

  it("detaches an attachment that replays failure during subscription", async () => {
    const { port, detachPlate } = runtimePort();
    port.mountPlate = vi.fn(() => ({
      detach: detachPlate,
      subscribeAvailabilityFailure(consumer: (error: unknown) => void) {
        consumer(new Error("renderer was already unavailable"));
        return vi.fn();
      },
    }));
    const primary = definition(
      "svelte5",
      implementation("svelte5", (context) => {
        context.runtime.mountPlate({} as HTMLCanvasElement);
        context.reportReady();
        return { detachView: vi.fn() };
      }),
    ) as UiNVersionDefinition & { id: "svelte5" };
    const standby = definition(
      "react",
      implementation("react", (context) => {
        context.reportReady();
        return { detachView: vi.fn() };
      }),
    ) as UiNVersionDefinition & { id: "react" };
    const host = supervisor(port, primary, standby, []);

    await host.start({} as HTMLElement);

    expect(host.getSnapshot()).toMatchObject({
      phase: "active",
      activeImplementationId: "react",
      failoverCount: 1,
    });
    expect(detachPlate).toHaveBeenCalledTimes(1);
  });

  it("revokes subscriptions even when a failed view omits its cleanup", async () => {
    const { port } = runtimePort();
    const value = uiSnapshot();
    const presentationConsumers = new Set<
      (snapshot: MandelHowlUiSnapshot) => void
    >();
    (
      port as {
        presentation: MandelHowlBrowserRuntimePort["presentation"];
      }
    ).presentation = {
      getSnapshot: () => value,
      subscribe: (
        consumer: (snapshot: MandelHowlUiSnapshot) => void,
      ) => {
        presentationConsumers.add(consumer);
        consumer(value);
        return () => {
          presentationConsumers.delete(consumer);
        };
      },
    };
    let primaryContext: UiViewMountContext | null = null;
    const primary = definition(
      "svelte5",
      implementation("svelte5", (context) => {
        primaryContext = context;
        context.runtime.presentation.subscribe(() => {});
        context.reportReady();
        // Deliberately omit the framework's subscription cleanup.
        return { detachView: vi.fn() };
      }),
    ) as UiNVersionDefinition & { id: "svelte5" };
    const standby = definition(
      "react",
      implementation("react", (context) => {
        context.reportReady();
        return { detachView: vi.fn() };
      }),
    ) as UiNVersionDefinition & { id: "react" };
    const host = supervisor(port, primary, standby, []);
    await host.start({} as HTMLElement);
    expect(presentationConsumers.size).toBe(1);

    const context = primaryContext as unknown as UiViewMountContext;
    context.reportAvailabilityFailure("view", new Error("view failed"));
    await flushTransitions();

    expect(host.getSnapshot().activeImplementationId).toBe("react");
    expect(presentationConsumers.size).toBe(0);
  });

  it("turns a presentation-consumer exception into view failover", async () => {
    const { port } = runtimePort();
    let value = uiSnapshot();
    const presentationConsumers = new Set<
      (snapshot: MandelHowlUiSnapshot) => void
    >();
    (
      port as {
        presentation: MandelHowlBrowserRuntimePort["presentation"];
      }
    ).presentation = {
      getSnapshot: () => value,
      subscribe: (
        consumer: (snapshot: MandelHowlUiSnapshot) => void,
      ) => {
        presentationConsumers.add(consumer);
        consumer(value);
        return () => {
          presentationConsumers.delete(consumer);
        };
      },
    };
    const primary = definition(
      "svelte5",
      implementation("svelte5", (context) => {
        context.runtime.presentation.subscribe((snapshot) => {
          if (snapshot.revision > 0) {
            throw new Error("framework subscriber failed");
          }
        });
        context.reportReady();
        return { detachView: vi.fn() };
      }),
    ) as UiNVersionDefinition & { id: "svelte5" };
    const standby = definition(
      "react",
      implementation("react", (context) => {
        context.reportReady();
        return { detachView: vi.fn() };
      }),
    ) as UiNVersionDefinition & { id: "react" };
    const host = supervisor(port, primary, standby, []);
    await host.start({} as HTMLElement);

    value = { ...value, revision: 1 };
    for (const consumer of Array.from(presentationConsumers)) {
      consumer(value);
    }
    await flushTransitions();

    expect(host.getSnapshot()).toMatchObject({
      phase: "active",
      activeImplementationId: "react",
      failoverCount: 1,
    });
    expect(presentationConsumers.size).toBe(0);
  });

  it("fails readiness and stale heartbeat into React without fail-back", async () => {
    vi.useFakeTimers();
    const { port } = runtimePort();
    const diagnostics: DiagnosticRecord[] = [];
    let standbyContext: UiViewMountContext | null = null;
    const primary = definition(
      "svelte5",
      implementation("svelte5", () => ({ detachView: vi.fn() })),
    ) as UiNVersionDefinition & { id: "svelte5" };
    const standby = definition(
      "react",
      implementation("react", (context) => {
        standbyContext = context;
        context.reportReady();
        return { detachView: vi.fn() };
      }),
    ) as UiNVersionDefinition & { id: "react" };
    const host = supervisor(port, primary, standby, diagnostics, 50);
    const starting = host.start({} as HTMLElement);
    await flushTransitions();
    await vi.advanceTimersByTimeAsync(51);
    await starting;

    expect(host.getSnapshot()).toMatchObject({
      phase: "active",
      activeImplementationId: "react",
      failoverCount: 1,
    });
    expect(diagnostics.map((record) => record.code)).toContain(
      "MH-UI-PRIMARY-READINESS-TIMEOUT",
    );

    const fallback = standbyContext as unknown as UiViewMountContext;
    fallback.reportHeartbeat(4);
    await vi.advanceTimersByTimeAsync(51);
    await flushTransitions();
    expect(host.getSnapshot().phase).toBe("unavailable");
    expect(primary.load).toHaveBeenCalledTimes(1);
    expect(standby.load).toHaveBeenCalledTimes(1);
    expect(diagnostics.map((record) => record.code)).toContain(
      "MH-UI-STANDBY-HEARTBEAT-STALE",
    );
    expect(diagnostics.map((record) => record.code)).toContain(
      "MH-UI-ALL-VERSIONS-FAILED",
    );
  });

  it("does not let duplicate snapshot sequences refresh UI liveness", async () => {
    vi.useFakeTimers();
    const { port } = runtimePort();
    const diagnostics: DiagnosticRecord[] = [];
    let primaryContext: UiViewMountContext | null = null;
    const primary = definition(
      "svelte5",
      implementation("svelte5", (context) => {
        primaryContext = context;
        context.reportReady();
        context.reportHeartbeat(0);
        return { detachView: vi.fn() };
      }),
    ) as UiNVersionDefinition & { id: "svelte5" };
    const standby = definition(
      "react",
      implementation("react", (context) => {
        context.reportReady();
        return { detachView: vi.fn() };
      }),
    ) as UiNVersionDefinition & { id: "react" };
    const host = supervisor(port, primary, standby, diagnostics, 50);
    await host.start({} as HTMLElement);

    await vi.advanceTimersByTimeAsync(40);
    const context = primaryContext as unknown as UiViewMountContext;
    context.reportHeartbeat(0);
    await vi.advanceTimersByTimeAsync(11);
    await flushTransitions();

    expect(host.getSnapshot()).toMatchObject({
      phase: "active",
      activeImplementationId: "react",
      failoverCount: 1,
    });
    expect(diagnostics.map((record) => record.code)).toContain(
      "MH-UI-PRIMARY-HEARTBEAT-STALE",
    );
  });

  it("never interprets a hidden-document heartbeat pause as failure", async () => {
    vi.useFakeTimers();
    const { port } = runtimePort();
    let visible = false;
    const diagnostics: DiagnosticRecord[] = [];
    let primaryContext: UiViewMountContext | null = null;
    const primary = definition(
      "svelte5",
      implementation("svelte5", (context) => {
        primaryContext = context;
        context.reportReady();
        context.reportHeartbeat(0);
        return { detachView: vi.fn() };
      }),
    ) as UiNVersionDefinition & { id: "svelte5" };
    const standby = definition(
      "react",
      implementation("react", (context) => {
        context.reportReady();
        return { detachView: vi.fn() };
      }),
    ) as UiNVersionDefinition & { id: "react" };
    const host = new UiNVersionSupervisor(port, {
      primary,
      standby,
      expectedScientificAlgorithmDigest: SCIENTIFIC_DIGEST,
      expectedPresentationContractDigest: PRESENTATION_DIGEST,
      readinessTimeoutMs: 50,
      heartbeatTimeoutMs: 50,
      shouldMonitorHeartbeat: () => visible,
      onDiagnostic: (record) => diagnostics.push(record),
    });

    await host.start({} as HTMLElement);
    await vi.advanceTimersByTimeAsync(250);
    expect(host.getSnapshot()).toMatchObject({
      phase: "active",
      activeImplementationId: "svelte5",
      failoverCount: 0,
    });
    expect(standby.load).not.toHaveBeenCalled();

    visible = true;
    const context = primaryContext as unknown as UiViewMountContext;
    context.reportHeartbeat(1);
    await vi.advanceTimersByTimeAsync(51);
    await flushTransitions();
    expect(host.getSnapshot()).toMatchObject({
      phase: "active",
      activeImplementationId: "react",
      failoverCount: 1,
    });
    expect(diagnostics.map((record) => record.code)).toContain(
      "MH-UI-PRIMARY-HEARTBEAT-STALE",
    );
  });

  it("grants a full heartbeat deadline after an explicit lifecycle resume", async () => {
    vi.useFakeTimers();
    const { port } = runtimePort();
    let primaryContext: UiViewMountContext | null = null;
    const primary = definition(
      "svelte5",
      implementation("svelte5", (context) => {
        primaryContext = context;
        context.reportReady();
        context.reportHeartbeat(0);
        return { detachView: vi.fn() };
      }),
    ) as UiNVersionDefinition & { id: "svelte5" };
    const standby = definition(
      "react",
      implementation("react", (context) => {
        context.reportReady();
        return { detachView: vi.fn() };
      }),
    ) as UiNVersionDefinition & { id: "react" };
    const host = supervisor(port, primary, standby, [], 50);
    await host.start({} as HTMLElement);

    host.notifyLifecyclePause();
    await vi.advanceTimersByTimeAsync(500);
    expect(host.getSnapshot().activeImplementationId).toBe("svelte5");

    host.notifyLifecycleResume();
    await vi.advanceTimersByTimeAsync(49);
    expect(host.getSnapshot().activeImplementationId).toBe("svelte5");
    const context = primaryContext as unknown as UiViewMountContext;
    context.reportHeartbeat(1);
    await vi.advanceTimersByTimeAsync(49);
    expect(host.getSnapshot()).toMatchObject({
      phase: "active",
      activeImplementationId: "svelte5",
      failoverCount: 0,
    });
  });

  it("quarantines scientific or presentation split-brain without loading either view", async () => {
    const { port } = runtimePort();
    const diagnostics: DiagnosticRecord[] = [];
    const primary = definition(
      "svelte5",
      implementation("svelte5", () => ({ detachView: vi.fn() })),
    ) as UiNVersionDefinition & { id: "svelte5" };
    const standby = definition(
      "react",
      implementation("react", () => ({ detachView: vi.fn() })),
      SCIENTIFIC_DIGEST,
      `sha256:${"3".repeat(64)}`,
    ) as UiNVersionDefinition & { id: "react" };
    const host = supervisor(port, primary, standby, diagnostics);

    await expect(host.start({} as HTMLElement)).resolves.toMatchObject({
      phase: "quarantined",
      activeImplementationId: null,
      failoverCount: 0,
    });
    expect(primary.load).not.toHaveBeenCalled();
    expect(standby.load).not.toHaveBeenCalled();
    expect(diagnostics.map((record) => record.code)).toEqual([
      "MH-UI-SPLIT-BRAIN",
    ]);
  });

  it("quarantines a loaded module identity mismatch instead of failing over", async () => {
    const { port } = runtimePort();
    const diagnostics: DiagnosticRecord[] = [];
    const primary = definition(
      "svelte5",
      implementation(
        "svelte5",
        () => ({ detachView: vi.fn() }),
        `sha256:${"4".repeat(64)}`,
      ),
    ) as UiNVersionDefinition & { id: "svelte5" };
    const standby = definition(
      "react",
      implementation("react", () => ({ detachView: vi.fn() })),
    ) as UiNVersionDefinition & { id: "react" };
    const host = supervisor(port, primary, standby, diagnostics);

    await host.start({} as HTMLElement);
    expect(host.getSnapshot()).toMatchObject({
      phase: "quarantined",
      failoverCount: 0,
    });
    expect(standby.load).not.toHaveBeenCalled();
    expect(diagnostics.map((record) => record.code)).toEqual([
      "MH-UI-SPLIT-BRAIN",
    ]);
  });

  it("detaches view resources without exposing or invoking runtime disposal", async () => {
    const { port, detachPlate } = runtimePort();
    const viewDetach = vi.fn();
    const primary = definition(
      "svelte5",
      implementation("svelte5", (context) => {
        const attachment = context.runtime.mountPlate(
          {} as HTMLCanvasElement,
        );
        context.reportReady();
        return {
          detachView() {
            attachment.detach();
            viewDetach();
          },
        };
      }),
    ) as UiNVersionDefinition & { id: "svelte5" };
    const standby = definition(
      "react",
      implementation("react", () => ({ detachView: vi.fn() })),
    ) as UiNVersionDefinition & { id: "react" };
    const host = supervisor(port, primary, standby, []);

    await host.start({} as HTMLElement);
    host.disposeView();
    expect(viewDetach).toHaveBeenCalledTimes(1);
    expect(detachPlate).toHaveBeenCalledTimes(1);
    expect("dispose" in port).toBe(false);
  });
});
