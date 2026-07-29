import type {
  DiagnosticEvidence,
  DiagnosticRecord,
  DiagnosticSeverity,
} from "../../contracts/src";
import type { DialCommand } from "../../dial-engine/src";
import type {
  MandelHowlBrowserRuntimePort,
  MandelHowlUiSnapshotReadable,
  MandelHowlViewAttachment,
  RuntimeSnapshotReadable,
} from "./runtime-port";

export type UiImplementationId = "svelte5" | "react";
export type UiImplementationRole = "primary" | "standby";
export type UiAvailabilityFailureStage =
  | "load"
  | "mount"
  | "readiness"
  | "heartbeat"
  | "view";

export interface UiImplementationIdentity {
  readonly id: UiImplementationId;
  /** Digest of the shared scientific/runtime algorithm contract. */
  readonly scientificAlgorithmDigest: string;
  /** Digest of the framework-independent presentation contract. */
  readonly presentationContractDigest: string;
}

/**
 * Generation-scoped capability handed to exactly one framework view.
 *
 * A stable input id is required so a failed primary cannot replay its final
 * event through the standby. The underlying runtime is deliberately not
 * disposable through this capability.
 */
export interface UiRuntimeInputLease {
  readonly contractVersion: "mandelhowl.ui-port.v1";
  readonly generation: number;
  readonly snapshots: RuntimeSnapshotReadable;
  readonly presentation: MandelHowlUiSnapshotReadable;
  mountPlate(canvas: HTMLCanvasElement): MandelHowlViewAttachment;
  dispatchDial(command: DialCommand, inputEventId: string): boolean;
  setDragging(dragging: boolean, inputEventId: string): boolean;
  activateAudio(inputEventId: string): Promise<boolean>;
}

export interface UiViewMountContext {
  readonly target: HTMLElement;
  readonly runtime: UiRuntimeInputLease;
  readonly signal: AbortSignal;
  reportReady(): void;
  reportHeartbeat(sequence: number): void;
  reportAvailabilityFailure(stage: "view", error?: unknown): void;
}

export interface UiViewSession {
  /** Detaches framework DOM/listeners only; never the shared runtime. */
  detachView(): void;
}

export interface UiNVersionImplementation extends UiImplementationIdentity {
  mount(
    context: UiViewMountContext,
  ): UiViewSession | Promise<UiViewSession>;
}

export interface UiNVersionDefinition extends UiImplementationIdentity {
  load(): Promise<UiNVersionImplementation>;
}

export type UiNVersionPhase =
  | "idle"
  | "mounting"
  | "active"
  | "failing-over"
  | "quarantined"
  | "unavailable"
  | "disposed";

export interface UiNVersionState {
  readonly phase: UiNVersionPhase;
  readonly activeImplementationId: UiImplementationId | null;
  readonly activeRole: UiImplementationRole | null;
  readonly generation: number;
  readonly failoverCount: number;
  readonly lastHeartbeatAtMs: number | null;
  readonly lastHeartbeatSequence: number | null;
}

export interface UiNVersionScheduler {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface UiNVersionSupervisorOptions {
  readonly primary: UiNVersionDefinition & { readonly id: "svelte5" };
  readonly standby: UiNVersionDefinition & { readonly id: "react" };
  readonly expectedScientificAlgorithmDigest: string;
  readonly expectedPresentationContractDigest: string;
  readonly readinessTimeoutMs?: number;
  readonly heartbeatTimeoutMs?: number;
  readonly retainedInputEventIds?: number;
  readonly scheduler?: UiNVersionScheduler;
  /**
   * Visibility/lifecycle predicate. While false, heartbeat deadlines are
   * re-armed and can never select the standby.
   */
  readonly shouldMonitorHeartbeat?: () => boolean;
  readonly onDiagnostic?: (diagnostic: DiagnosticRecord) => void;
  readonly onStateChange?: (state: UiNVersionState) => void;
}

interface AvailabilityFailure {
  readonly stage: UiAvailabilityFailureStage;
  readonly errorKind: string;
}

interface ActivationAttempt {
  readonly token: number;
  readonly role: UiImplementationRole;
  readonly definition: UiNVersionDefinition;
  /** Stable host owned by the route bootstrap across implementation attempts. */
  readonly target: HTMLElement;
  /** Generation-local child handed to one implementation only. */
  readonly mountTarget: HTMLElement;
  readonly generation: number;
  readonly abortController: AbortController;
  readonly attachments: Set<MandelHowlViewAttachment>;
  readonly subscriptions: Set<() => void>;
  readonly readiness: Promise<void>;
  readonly availabilityFailure: Promise<AvailabilityFailure>;
  availabilityFailureValue: AvailabilityFailure | null;
  resolveReadiness(): void;
  resolveAvailabilityFailure(failure: AvailabilityFailure): void;
  stage: UiAvailabilityFailureStage;
  view: UiViewSession | null;
  activationTimer: unknown;
  heartbeatTimer: unknown;
  lastHeartbeatAtMs: number | null;
  lastHeartbeatSequence: number | null;
  pointerGestureActive: boolean;
  lastPointerTimestampMs: number | null;
  heartbeatPaused: boolean;
  closed: boolean;
}

const DEFAULT_READINESS_TIMEOUT_MS = 1_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 1_500;
const DEFAULT_RETAINED_INPUT_EVENT_IDS = 512;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

const DEFAULT_SCHEDULER: UiNVersionScheduler = Object.freeze({
  now: () =>
    typeof performance === "undefined" ? Date.now() : performance.now(),
  setTimeout: (callback: () => void, delayMs: number) =>
    globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle: unknown) => {
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
});

const NOOP_VIEW_ATTACHMENT: MandelHowlViewAttachment = Object.freeze({
  detach() {},
});

function finitePositive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0
    ? value
    : fallback;
}

function createGenerationMountTarget(
  target: HTMLElement,
  generation: number,
): HTMLElement {
  if (
    typeof target.replaceChildren !== "function" ||
    !target.ownerDocument ||
    typeof target.ownerDocument.createElement !== "function"
  ) {
    // Structural test doubles and non-DOM hosts retain the legacy target.
    return target;
  }
  const mountTarget = target.ownerDocument.createElement("div");
  mountTarget.className = "mh-ui-generation-target";
  mountTarget.dataset.uiGeneration = String(generation);
  target.replaceChildren(mountTarget);
  return mountTarget;
}

function errorKind(error: unknown): string {
  if (error instanceof Error && error.name) return error.name;
  if (error === null) return "null";
  return typeof error;
}

function frozenState(state: UiNVersionState): UiNVersionState {
  return Object.freeze({ ...state });
}

function diagnostic(
  code: string,
  severity: DiagnosticSeverity,
  messageKey: string,
  evidence: readonly DiagnosticEvidence[],
): DiagnosticRecord {
  return Object.freeze({
    code,
    severity,
    evidenceState: "confirmed",
    messageKey,
    evidence: Object.freeze([...evidence]),
  });
}

function failureCode(
  role: UiImplementationRole,
  stage: UiAvailabilityFailureStage,
): string {
  const roleSegment = role === "primary" ? "PRIMARY" : "STANDBY";
  if (stage === "readiness") {
    return `MH-UI-${roleSegment}-READINESS-TIMEOUT`;
  }
  if (stage === "heartbeat") {
    return `MH-UI-${roleSegment}-HEARTBEAT-STALE`;
  }
  return `MH-UI-${roleSegment}-${stage.toUpperCase()}-FAILED`;
}

function sameIdentity(
  left: UiImplementationIdentity,
  right: UiImplementationIdentity,
): boolean {
  return (
    left.id === right.id &&
    left.scientificAlgorithmDigest === right.scientificAlgorithmDigest &&
    left.presentationContractDigest === right.presentationContractDigest
  );
}

/**
 * Svelte-primary/React-standby supervisor over one canonical runtime.
 *
 * Only confirmed availability failures can activate React. Contract-digest
 * disagreement is split-brain and quarantines both versions. Selection is
 * one-way for the supervisor lifetime: no fail-back or retry loop exists.
 */
export class UiNVersionSupervisor {
  private readonly runtime: MandelHowlBrowserRuntimePort;
  private readonly options: UiNVersionSupervisorOptions;
  private readonly scheduler: UiNVersionScheduler;
  private readonly readinessTimeoutMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly retainedInputEventIds: number;
  private readonly consumedInputIds = new Set<string>();
  private readonly consumedInputOrder: string[] = [];
  private readonly emittedInputDiagnostics = new Set<string>();
  private currentAttempt: ActivationAttempt | null = null;
  private lifecycleToken = 0;
  private generation = 0;
  private failoverCount = 0;
  private started = false;
  private disposed = false;
  private state: UiNVersionState = frozenState({
    phase: "idle",
    activeImplementationId: null,
    activeRole: null,
    generation: 0,
    failoverCount: 0,
    lastHeartbeatAtMs: null,
    lastHeartbeatSequence: null,
  });

  constructor(
    runtime: MandelHowlBrowserRuntimePort,
    options: UiNVersionSupervisorOptions,
  ) {
    this.runtime = runtime;
    this.options = options;
    this.scheduler = options.scheduler ?? DEFAULT_SCHEDULER;
    this.readinessTimeoutMs = finitePositive(
      options.readinessTimeoutMs,
      DEFAULT_READINESS_TIMEOUT_MS,
    );
    this.heartbeatTimeoutMs = finitePositive(
      options.heartbeatTimeoutMs,
      DEFAULT_HEARTBEAT_TIMEOUT_MS,
    );
    this.retainedInputEventIds = positiveInteger(
      options.retainedInputEventIds,
      DEFAULT_RETAINED_INPUT_EVENT_IDS,
    );
  }

  getSnapshot(): UiNVersionState {
    return this.state;
  }

  async start(target: HTMLElement): Promise<UiNVersionState> {
    if (this.started) {
      throw new Error("UiNVersionSupervisor can only be started once.");
    }
    this.started = true;
    if (this.disposed) return this.state;

    const mismatch = this.contractMismatch();
    if (mismatch) {
      this.quarantine(mismatch.dimension, mismatch.expected, mismatch.actual);
      return this.state;
    }

    await this.activate(this.options.primary, "primary", target);
    return this.state;
  }

  /**
   * Detaches only the selected framework view. Runtime disposal remains an
   * explicit, separate `MandelHowlBrowserSessionOwner` capability.
   */
  disposeView(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lifecycleToken += 1;
    this.cleanupAttempt(this.currentAttempt);
    this.currentAttempt = null;
    this.updateState({
      phase: "disposed",
      activeImplementationId: null,
      activeRole: null,
      lastHeartbeatAtMs: null,
      lastHeartbeatSequence: null,
    });
  }

  /**
   * Suspends heartbeat deadlines during a lifecycle pause. Input-generation
   * validity is unchanged; only the view-liveness timer is stopped.
   */
  notifyLifecyclePause(): void {
    const attempt = this.currentAttempt;
    if (!attempt || !this.isCurrent(attempt)) return;
    attempt.heartbeatPaused = true;
    this.scheduler.clearTimeout(attempt.heartbeatTimer);
    attempt.heartbeatTimer = null;
  }

  /**
   * Grants the selected view one full heartbeat interval after a page/tab
   * resumes. This prevents an overdue background timer from selecting standby
   * before the browser has allowed the primary to commit its first frame.
   */
  notifyLifecycleResume(): void {
    const attempt = this.currentAttempt;
    if (!attempt || !this.isCurrent(attempt)) return;
    attempt.heartbeatPaused = false;
    if (this.state.phase === "active") this.armHeartbeat(attempt);
  }

  private contractMismatch(): {
    dimension: string;
    expected: string;
    actual: string;
  } | null {
    if (this.options.primary.id !== "svelte5") {
      return {
        dimension: "primary-role",
        expected: "svelte5",
        actual: this.options.primary.id,
      };
    }
    if (this.options.standby.id !== "react") {
      return {
        dimension: "standby-role",
        expected: "react",
        actual: this.options.standby.id,
      };
    }
    const identities = [this.options.primary, this.options.standby];
    for (const identity of identities) {
      if (!DIGEST_PATTERN.test(identity.scientificAlgorithmDigest)) {
        return {
          dimension: `${identity.id}:scientific-digest-format`,
          expected: "sha256:<64 lowercase hex>",
          actual: identity.scientificAlgorithmDigest,
        };
      }
      if (!DIGEST_PATTERN.test(identity.presentationContractDigest)) {
        return {
          dimension: `${identity.id}:presentation-digest-format`,
          expected: "sha256:<64 lowercase hex>",
          actual: identity.presentationContractDigest,
        };
      }
      if (
        identity.scientificAlgorithmDigest !==
        this.options.expectedScientificAlgorithmDigest
      ) {
        return {
          dimension: `${identity.id}:scientific-algorithm`,
          expected: this.options.expectedScientificAlgorithmDigest,
          actual: identity.scientificAlgorithmDigest,
        };
      }
      if (
        identity.presentationContractDigest !==
        this.options.expectedPresentationContractDigest
      ) {
        return {
          dimension: `${identity.id}:presentation-contract`,
          expected: this.options.expectedPresentationContractDigest,
          actual: identity.presentationContractDigest,
        };
      }
    }
    return null;
  }

  private async activate(
    definition: UiNVersionDefinition,
    role: UiImplementationRole,
    target: HTMLElement,
  ): Promise<void> {
    if (this.disposed) return;
    const attempt = this.createAttempt(definition, role, target);
    this.currentAttempt = attempt;
    this.updateState({
      phase: "mounting",
      activeImplementationId: definition.id,
      activeRole: role,
      generation: attempt.generation,
      lastHeartbeatAtMs: null,
      lastHeartbeatSequence: null,
    });

    attempt.activationTimer = this.scheduler.setTimeout(() => {
      attempt.resolveAvailabilityFailure({
        stage: attempt.stage,
        errorKind: "TimeoutError",
      });
    }, this.readinessTimeoutMs);

    let loadInvocation: ReturnType<UiNVersionDefinition["load"]>;
    try {
      loadInvocation = definition.load();
    } catch (error) {
      await this.handleAvailabilityFailure(attempt, {
        stage: "load",
        errorKind: errorKind(error),
      });
      return;
    }
    const loadResult = await Promise.race([
      Promise.resolve(loadInvocation).then(
        (implementation) =>
          ({ kind: "loaded", implementation }) as const,
        (error: unknown) =>
          ({
            kind: "failure",
            failure: {
              stage: "load",
              errorKind: errorKind(error),
            },
          }) as const,
      ),
      attempt.availabilityFailure.then(
        (failure) => ({ kind: "failure", failure }) as const,
      ),
    ]);
    if (loadResult.kind === "failure") {
      await this.handleAvailabilityFailure(attempt, loadResult.failure);
      return;
    }
    if (attempt.availabilityFailureValue) {
      await this.handleAvailabilityFailure(
        attempt,
        attempt.availabilityFailureValue,
      );
      return;
    }
    if (!this.isCurrent(attempt)) return;

    const implementation = loadResult.implementation;
    if (!sameIdentity(definition, implementation)) {
      this.quarantine(
        `${definition.id}:loaded-module-identity`,
        `${definition.id}:${definition.scientificAlgorithmDigest}:${definition.presentationContractDigest}`,
        `${implementation.id}:${implementation.scientificAlgorithmDigest}:${implementation.presentationContractDigest}`,
      );
      return;
    }

    attempt.stage = "mount";
    const context = this.createMountContext(attempt);
    let mountInvocation: ReturnType<UiNVersionImplementation["mount"]>;
    try {
      mountInvocation = implementation.mount(context);
    } catch (error) {
      await this.handleAvailabilityFailure(attempt, {
        stage: "mount",
        errorKind: errorKind(error),
      });
      return;
    }
    const mounting = Promise.resolve(mountInvocation).then(
      (view) => {
        if (!this.isCurrent(attempt)) {
          try {
            view.detachView();
          } catch {
            // Stale input capabilities are already revoked.
          }
          return { kind: "stale" } as const;
        }
        return { kind: "mounted", view } as const;
      },
      (error: unknown) =>
        ({
          kind: "failure",
          failure: {
            stage: "mount",
            errorKind: errorKind(error),
          },
        }) as const,
    );
    const mountResult = await Promise.race([
      mounting,
      attempt.availabilityFailure.then(
        (failure) => ({ kind: "failure", failure }) as const,
      ),
    ]);
    if (mountResult.kind === "failure") {
      await this.handleAvailabilityFailure(attempt, mountResult.failure);
      return;
    }
    if (mountResult.kind === "stale" || !this.isCurrent(attempt)) return;
    attempt.view = mountResult.view;
    if (attempt.availabilityFailureValue) {
      await this.handleAvailabilityFailure(
        attempt,
        attempt.availabilityFailureValue,
      );
      return;
    }

    attempt.stage = "readiness";
    const readinessResult = await Promise.race([
      attempt.readiness.then(() => ({ kind: "ready" }) as const),
      attempt.availabilityFailure.then(
        (failure) => ({ kind: "failure", failure }) as const,
      ),
    ]);
    if (readinessResult.kind === "failure") {
      await this.handleAvailabilityFailure(attempt, readinessResult.failure);
      return;
    }
    if (attempt.availabilityFailureValue) {
      await this.handleAvailabilityFailure(
        attempt,
        attempt.availabilityFailureValue,
      );
      return;
    }
    if (!this.isCurrent(attempt)) return;

    this.scheduler.clearTimeout(attempt.activationTimer);
    attempt.activationTimer = null;
    attempt.stage = "heartbeat";
    this.updateState({
      phase: "active",
      activeImplementationId: definition.id,
      activeRole: role,
      lastHeartbeatAtMs: attempt.lastHeartbeatAtMs,
      lastHeartbeatSequence: attempt.lastHeartbeatSequence,
    });
    this.armHeartbeat(attempt);
  }

  private createAttempt(
    definition: UiNVersionDefinition,
    role: UiImplementationRole,
    target: HTMLElement,
  ): ActivationAttempt {
    const token = ++this.lifecycleToken;
    const generation = ++this.generation;
    const mountTarget = createGenerationMountTarget(target, generation);
    let resolveReadiness = () => {};
    let resolveAvailabilityFailure: (
      failure: AvailabilityFailure,
    ) => void = () => {};
    let readinessResolved = false;
    let failureResolved = false;
    const readiness = new Promise<void>((resolve) => {
      resolveReadiness = () => {
        if (readinessResolved) return;
        readinessResolved = true;
        resolve();
      };
    });
    let createdAttempt: ActivationAttempt | null = null;
    const availabilityFailure = new Promise<AvailabilityFailure>((resolve) => {
      resolveAvailabilityFailure = (failure) => {
        if (failureResolved) return;
        failureResolved = true;
        if (createdAttempt) {
          createdAttempt.availabilityFailureValue = failure;
        }
        resolve(failure);
      };
    });
    createdAttempt = {
      token,
      role,
      definition,
      target,
      mountTarget,
      generation,
      abortController: new AbortController(),
      attachments: new Set(),
      subscriptions: new Set(),
      readiness,
      availabilityFailure,
      availabilityFailureValue: null,
      resolveReadiness,
      resolveAvailabilityFailure,
      stage: "load",
      view: null,
      activationTimer: null,
      heartbeatTimer: null,
      lastHeartbeatAtMs: null,
      lastHeartbeatSequence: null,
      pointerGestureActive: false,
      lastPointerTimestampMs: null,
      heartbeatPaused: !this.shouldMonitorHeartbeat(),
      closed: false,
    };
    return createdAttempt;
  }

  private createMountContext(attempt: ActivationAttempt): UiViewMountContext {
    const snapshots: RuntimeSnapshotReadable = Object.freeze({
      getSnapshot: () =>
        this.getViewSnapshot(attempt, this.runtime.snapshots),
      subscribe: (
        consumer: Parameters<RuntimeSnapshotReadable["subscribe"]>[0],
      ) =>
        this.subscribeView(
          attempt,
          this.runtime.snapshots,
          consumer,
        ),
    });
    const presentation: MandelHowlUiSnapshotReadable = Object.freeze({
      getSnapshot: () =>
        this.getViewSnapshot(attempt, this.runtime.presentation),
      subscribe: (
        consumer: Parameters<MandelHowlUiSnapshotReadable["subscribe"]>[0],
      ) =>
        this.subscribeView(
          attempt,
          this.runtime.presentation,
          consumer,
        ),
    });
    const runtimeLease: UiRuntimeInputLease = Object.freeze({
      contractVersion: this.runtime.contractVersion,
      generation: attempt.generation,
      snapshots,
      presentation,
      mountPlate: (canvas: HTMLCanvasElement) =>
        this.mountPlate(attempt, canvas),
      dispatchDial: (command: DialCommand, inputEventId: string) =>
        this.dispatchDial(attempt, command, inputEventId),
      setDragging: (dragging: boolean, inputEventId: string) =>
        this.setDragging(attempt, dragging, inputEventId),
      activateAudio: (inputEventId: string) =>
        this.activateAudio(attempt, inputEventId),
    });
    return Object.freeze({
      target: attempt.mountTarget,
      runtime: runtimeLease,
      signal: attempt.abortController.signal,
      reportReady: () => {
        if (this.isCurrent(attempt)) attempt.resolveReadiness();
      },
      reportHeartbeat: (sequence: number) => {
        this.reportHeartbeat(attempt, sequence);
      },
      reportAvailabilityFailure: (stage: "view", error?: unknown) => {
        this.reportAvailabilityFailure(attempt, stage, error);
      },
    });
  }

  private mountPlate(
    attempt: ActivationAttempt,
    canvas: HTMLCanvasElement,
  ): MandelHowlViewAttachment {
    if (!this.isCurrent(attempt)) {
      this.reportRejectedInput(attempt, "stale-view");
      return NOOP_VIEW_ATTACHMENT;
    }
    let sourceAttachment: MandelHowlViewAttachment;
    try {
      sourceAttachment = this.runtime.mountPlate(canvas);
    } catch (error) {
      this.reportAvailabilityFailure(attempt, "view", error);
      return NOOP_VIEW_ATTACHMENT;
    }
    let detached = false;
    let unsubscribeAvailabilityFailure = () => {};
    try {
      const unsubscribe = sourceAttachment.subscribeAvailabilityFailure?.(
        (error) => {
          if (!detached) {
            this.reportAvailabilityFailure(attempt, "view", error);
          }
        },
      );
      if (typeof unsubscribe === "function") {
        unsubscribeAvailabilityFailure = unsubscribe;
      }
    } catch (error) {
      try {
        sourceAttachment.detach();
      } catch {
        // The source is already considered unavailable.
      }
      this.reportAvailabilityFailure(attempt, "view", error);
      return NOOP_VIEW_ATTACHMENT;
    }
    // A source may synchronously replay a previously observed failure while
    // its availability channel is being subscribed. In that case supervisor
    // cleanup can revoke this generation before the wrapper is registered.
    // Detach it here instead of adding a resource to an already closed set.
    if (!this.isCurrent(attempt)) {
      try {
        unsubscribeAvailabilityFailure();
      } catch {
        // Observer cleanup remains best effort for an unavailable source.
      }
      try {
        sourceAttachment.detach();
      } catch {
        // The source has already been quarantined.
      }
      return NOOP_VIEW_ATTACHMENT;
    }
    const attachment: MandelHowlViewAttachment = Object.freeze({
      detach: () => {
        if (detached) return;
        detached = true;
        attempt.attachments.delete(attachment);
        try {
          unsubscribeAvailabilityFailure();
        } catch {
          // Availability observer cleanup remains attachment-scoped.
        }
        try {
          sourceAttachment.detach();
        } catch {
          // View cleanup cannot poison the shared runtime.
        }
      },
    });
    attempt.attachments.add(attachment);
    return attachment;
  }

  private getViewSnapshot<T>(
    attempt: ActivationAttempt,
    source: { getSnapshot(): T },
  ): T {
    try {
      return source.getSnapshot();
    } catch (error) {
      this.reportAvailabilityFailure(attempt, "view", error);
      throw error;
    }
  }

  /**
   * Tracks every framework subscription as a generation-owned resource.
   *
   * Framework unmount remains responsible for its normal cleanup, but a
   * timed-out or crashed implementation cannot retain a canonical-store
   * listener. Consumer exceptions are promoted to view availability failures
   * before the shared publisher contains them.
   */
  private subscribeView<T>(
    attempt: ActivationAttempt,
    source: {
      subscribe(consumer: (snapshot: T) => void): () => void;
    },
    consumer: (snapshot: T) => void,
  ): () => void {
    if (!this.isCurrent(attempt)) {
      this.reportRejectedInput(attempt, "stale-view");
      return () => {};
    }

    let detached = false;
    let sourceUnsubscribe = () => {};
    const unsubscribe = () => {
      if (detached) return;
      detached = true;
      attempt.subscriptions.delete(unsubscribe);
      try {
        sourceUnsubscribe();
      } catch {
        // Subscription cleanup cannot destabilize the canonical publisher.
      }
    };

    try {
      sourceUnsubscribe = source.subscribe((snapshot) => {
        if (!this.isCurrent(attempt)) return;
        try {
          consumer(snapshot);
        } catch (error) {
          this.reportAvailabilityFailure(attempt, "view", error);
        }
      });
    } catch (error) {
      this.reportAvailabilityFailure(attempt, "view", error);
      return () => {};
    }

    if (!this.isCurrent(attempt)) {
      unsubscribe();
      return () => {};
    }
    attempt.subscriptions.add(unsubscribe);
    return unsubscribe;
  }

  private dispatchDial(
    attempt: ActivationAttempt,
    command: DialCommand,
    inputEventId: string,
  ): boolean {
    if (!this.isCurrent(attempt)) {
      this.reportRejectedInput(attempt, "stale-generation");
      return false;
    }
    if (!this.consumeInputId("dial", inputEventId)) {
      this.reportRejectedInput(attempt, "duplicate-input");
      return false;
    }
    this.runtime.dispatchDial(command);
    if (command.type === "pointer-start") {
      attempt.pointerGestureActive = true;
      attempt.lastPointerTimestampMs = command.timestampMs;
    } else if (command.type === "pointer-move") {
      attempt.lastPointerTimestampMs = command.timestampMs;
    } else if (
      command.type === "pointer-end" ||
      command.type === "pointer-cancel"
    ) {
      attempt.pointerGestureActive = false;
      attempt.lastPointerTimestampMs = command.timestampMs;
    }
    return true;
  }

  private setDragging(
    attempt: ActivationAttempt,
    dragging: boolean,
    inputEventId: string,
  ): boolean {
    if (!this.isCurrent(attempt)) {
      this.reportRejectedInput(attempt, "stale-generation");
      return false;
    }
    if (!this.consumeInputId("dragging", inputEventId)) {
      this.reportRejectedInput(attempt, "duplicate-input");
      return false;
    }
    this.runtime.setDragging(dragging);
    return true;
  }

  private async activateAudio(
    attempt: ActivationAttempt,
    inputEventId: string,
  ): Promise<boolean> {
    if (!this.isCurrent(attempt)) {
      this.reportRejectedInput(attempt, "stale-generation");
      return false;
    }
    if (!this.consumeInputId("audio", inputEventId)) {
      this.reportRejectedInput(attempt, "duplicate-input");
      return false;
    }
    return this.runtime.activateAudio();
  }

  private consumeInputId(operation: string, inputEventId: string): boolean {
    if (typeof inputEventId !== "string" || inputEventId.length === 0) {
      return false;
    }
    const key = `${operation}:${inputEventId}`;
    if (this.consumedInputIds.has(key)) return false;
    this.consumedInputIds.add(key);
    this.consumedInputOrder.push(key);
    while (this.consumedInputOrder.length > this.retainedInputEventIds) {
      const oldest = this.consumedInputOrder.shift();
      if (oldest !== undefined) this.consumedInputIds.delete(oldest);
    }
    return true;
  }

  private reportRejectedInput(
    attempt: ActivationAttempt,
    reason: "stale-generation" | "duplicate-input" | "stale-view",
  ): void {
    const signature = `${attempt.generation}:${reason}`;
    if (this.emittedInputDiagnostics.has(signature)) return;
    this.emittedInputDiagnostics.add(signature);
    this.emitDiagnostic(
      diagnostic(
        reason === "duplicate-input"
          ? "MH-UI-DUPLICATE-INPUT-REJECTED"
          : "MH-UI-STALE-INPUT-REJECTED",
        "info",
        "ui.inputRejected",
        [
          {
            key: "implementationId",
            value: attempt.definition.id,
            source: "ui-nversion-supervisor",
          },
          {
            key: "generation",
            value: attempt.generation,
            source: "ui-nversion-supervisor",
          },
          {
            key: "reason",
            value: reason,
            source: "ui-nversion-supervisor",
          },
        ],
      ),
    );
  }

  private reportHeartbeat(
    attempt: ActivationAttempt,
    sequence: number,
  ): void {
    if (
      !this.isCurrent(attempt) ||
      !Number.isInteger(sequence) ||
      sequence < 0 ||
      (attempt.lastHeartbeatSequence !== null &&
        sequence < attempt.lastHeartbeatSequence)
    ) {
      return;
    }
    attempt.lastHeartbeatAtMs = this.scheduler.now();
    attempt.lastHeartbeatSequence = sequence;
    if (this.shouldMonitorHeartbeat()) {
      attempt.heartbeatPaused = false;
    }
    if (this.state.phase === "active") {
      this.updateState({
        lastHeartbeatAtMs: attempt.lastHeartbeatAtMs,
        lastHeartbeatSequence: sequence,
      });
      this.armHeartbeat(attempt);
    }
  }

  private reportAvailabilityFailure(
    attempt: ActivationAttempt,
    stage: "view",
    error: unknown,
  ): void {
    if (!this.isCurrent(attempt)) return;
    const failure = { stage, errorKind: errorKind(error) } as const;
    if (this.state.phase === "active") {
      void this.handleAvailabilityFailure(attempt, failure);
    } else {
      attempt.resolveAvailabilityFailure(failure);
    }
  }

  private armHeartbeat(attempt: ActivationAttempt): void {
    this.scheduler.clearTimeout(attempt.heartbeatTimer);
    attempt.heartbeatTimer = null;
    if (attempt.heartbeatPaused) return;
    attempt.heartbeatTimer = this.scheduler.setTimeout(() => {
      if (!this.isCurrent(attempt) || this.state.phase !== "active") return;
      if (!this.shouldMonitorHeartbeat()) {
        attempt.heartbeatPaused = true;
        attempt.heartbeatTimer = null;
        return;
      }
      void this.handleAvailabilityFailure(attempt, {
        stage: "heartbeat",
        errorKind: "TimeoutError",
      });
    }, this.heartbeatTimeoutMs);
  }

  private shouldMonitorHeartbeat(): boolean {
    try {
      return this.options.shouldMonitorHeartbeat?.() ?? true;
    } catch {
      // A broken visibility observer must not permanently suppress detection.
      return true;
    }
  }

  private async handleAvailabilityFailure(
    attempt: ActivationAttempt,
    failure: AvailabilityFailure,
  ): Promise<void> {
    if (!this.isCurrent(attempt)) return;
    this.emitDiagnostic(
      diagnostic(
        failureCode(attempt.role, failure.stage),
        attempt.role === "primary" ? "warning" : "fatal",
        "ui.versionAvailabilityFailure",
        [
          {
            key: "implementationId",
            value: attempt.definition.id,
            source: "ui-nversion-supervisor",
          },
          {
            key: "role",
            value: attempt.role,
            source: "ui-nversion-supervisor",
          },
          {
            key: "stage",
            value: failure.stage,
            source: "ui-nversion-supervisor",
          },
          {
            key: "errorKind",
            value: failure.errorKind,
            source: "ui-nversion-supervisor",
          },
          {
            key: "generation",
            value: attempt.generation,
            source: "ui-nversion-supervisor",
          },
        ],
      ),
    );
    this.cleanupAttempt(attempt);
    this.currentAttempt = null;

    if (attempt.role === "primary" && !this.disposed) {
      this.failoverCount += 1;
      this.updateState({
        phase: "failing-over",
        activeImplementationId: null,
        activeRole: null,
        failoverCount: this.failoverCount,
        lastHeartbeatAtMs: null,
        lastHeartbeatSequence: null,
      });
      this.emitDiagnostic(
        diagnostic(
          "MH-UI-FAILOVER-ACTIVATED",
          "warning",
          "ui.failoverActivated",
          [
            {
              key: "from",
              value: "svelte5",
              source: "ui-nversion-supervisor",
            },
            {
              key: "to",
              value: "react",
              source: "ui-nversion-supervisor",
            },
            {
              key: "failureStage",
              value: failure.stage,
              source: "ui-nversion-supervisor",
            },
          ],
        ),
      );
      await this.activate(this.options.standby, "standby", attempt.target);
      return;
    }

    if (!this.disposed) {
      this.updateState({
        phase: "unavailable",
        activeImplementationId: null,
        activeRole: null,
        lastHeartbeatAtMs: null,
        lastHeartbeatSequence: null,
      });
      this.emitDiagnostic(
        diagnostic(
          "MH-UI-ALL-VERSIONS-FAILED",
          "fatal",
          "ui.allVersionsFailed",
          [
            {
              key: "lastImplementationId",
              value: attempt.definition.id,
              source: "ui-nversion-supervisor",
            },
            {
              key: "lastFailureStage",
              value: failure.stage,
              source: "ui-nversion-supervisor",
            },
          ],
        ),
      );
    }
  }

  private quarantine(
    dimension: string,
    expected: string,
    actual: string,
  ): void {
    this.lifecycleToken += 1;
    this.cleanupAttempt(this.currentAttempt);
    this.currentAttempt = null;
    this.updateState({
      phase: "quarantined",
      activeImplementationId: null,
      activeRole: null,
      lastHeartbeatAtMs: null,
      lastHeartbeatSequence: null,
    });
    this.emitDiagnostic(
      diagnostic(
        "MH-UI-SPLIT-BRAIN",
        "fatal",
        "ui.contractDigestMismatch",
        [
          {
            key: "dimension",
            value: dimension,
            source: "ui-nversion-supervisor",
          },
          {
            key: "expected",
            value: expected,
            source: "ui-nversion-supervisor",
          },
          {
            key: "actual",
            value: actual,
            source: "ui-nversion-supervisor",
          },
          {
            key: "automaticSelection",
            value: false,
            source: "ui-nversion-supervisor",
          },
        ],
      ),
    );
  }

  private cleanupAttempt(attempt: ActivationAttempt | null): void {
    if (!attempt || attempt.closed) return;
    attempt.closed = true;
    if (attempt.pointerGestureActive) {
      attempt.pointerGestureActive = false;
      const timestampMs = Math.max(
        this.scheduler.now(),
        attempt.lastPointerTimestampMs ?? 0,
      );
      try {
        this.runtime.dispatchDial({ type: "pointer-cancel", timestampMs });
      } catch {
        // The view is already revoked; continue with presentation cleanup.
      }
      try {
        this.runtime.setDragging(false);
      } catch {
        // Session teardown and standby activation must remain available.
      }
    }
    attempt.resolveAvailabilityFailure({
      stage: attempt.stage,
      errorKind: "AbortError",
    });
    attempt.abortController.abort();
    this.scheduler.clearTimeout(attempt.activationTimer);
    this.scheduler.clearTimeout(attempt.heartbeatTimer);
    for (const unsubscribe of attempt.subscriptions) {
      try {
        unsubscribe();
      } catch {
        // Generation revocation must continue across faulty subscribers.
      }
    }
    attempt.subscriptions.clear();
    if (attempt.view) {
      try {
        // Give the framework a chance to detach the wrapped attachment first,
        // so an idempotent base attachment is not required.
        attempt.view.detachView();
      } catch {
        // Framework unmount cannot acquire runtime ownership.
      }
      attempt.view = null;
    }
    for (const attachment of attempt.attachments) {
      try {
        attachment.detach();
      } catch {
        // Cleanup remains view-scoped even if an adapter is faulty.
      }
    }
    attempt.attachments.clear();
    if (
      attempt.mountTarget !== attempt.target &&
      typeof attempt.mountTarget.remove === "function"
    ) {
      attempt.mountTarget.remove();
    }
  }

  private isCurrent(attempt: ActivationAttempt): boolean {
    return (
      !this.disposed &&
      !attempt.closed &&
      this.currentAttempt === attempt &&
      attempt.token === this.lifecycleToken
    );
  }

  private updateState(
    patch: Partial<Omit<UiNVersionState, "generation" | "failoverCount">> & {
      readonly generation?: number;
      readonly failoverCount?: number;
    },
  ): void {
    this.state = frozenState({
      ...this.state,
      ...patch,
      generation: patch.generation ?? this.generation,
      failoverCount: patch.failoverCount ?? this.failoverCount,
    });
    try {
      this.options.onStateChange?.(this.state);
    } catch {
      // Observability cannot affect selection or runtime ownership.
    }
  }

  private emitDiagnostic(record: DiagnosticRecord): void {
    try {
      this.options.onDiagnostic?.(record);
    } catch {
      // Diagnostics cannot affect failover.
    }
  }
}
