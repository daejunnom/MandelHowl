import type { RuntimeSnapshot } from "../../contracts/src";
import type { DialCommand } from "../../dial-engine/src";
import type { PlateRendererStatus } from "../../render-engine/src";
import {
  RuntimeSnapshotFanout,
  type SnapshotConsumer,
  type SnapshotFanoutMetrics,
} from "./snapshot-fanout";

export interface RuntimeSnapshotReadable {
  /** Svelte-compatible readable-store subscription contract. */
  subscribe(consumer: SnapshotConsumer): () => void;
  getSnapshot(): RuntimeSnapshot;
}

export type MandelHowlDatasetStatus =
  | "loading"
  | "verified"
  | "prototype"
  | "error";

export type MandelHowlDatasetPresentationState =
  | MandelHowlDatasetStatus
  | "streaming";

export interface MandelHowlPresentedDiagnostic {
  readonly severity: "none" | "info" | "warning" | "fatal";
  readonly title: string | null;
  readonly message: string | null;
  readonly code: string | null;
  readonly detail: string | null;
}

/**
 * Owned state exposed to UI implementations.
 *
 * The scientific snapshot remains canonical. The remaining fields are
 * browser-session presentation state which cannot be reconstructed by a view
 * (dataset promotion, audio activation, renderer health and host challenge).
 */
export interface MandelHowlUiSnapshot {
  readonly contractVersion: "mandelhowl.ui-port.v1";
  readonly revision: number;
  readonly runtime: RuntimeSnapshot;
  readonly minimumFrequencyHz: number;
  readonly maximumFrequencyHz: number;
  readonly radialDeadZone: number;
  readonly dragging: boolean;
  readonly audioEnabled: boolean;
  readonly datasetStatus: MandelHowlDatasetStatus;
  readonly renderer: PlateRendererStatus | null;
  readonly diagnostic: MandelHowlPresentedDiagnostic;
  readonly challengeTarget: number | null;
}

/**
 * Fail-closed scientific presentation gate shared by both UI versions.
 *
 * Loader verification establishes the immutable core/provenance identity.
 * A view may claim the visible bake only after its renderer has the same
 * dataset and has verified every texture shard required by the current mode.
 */
export function resolveDatasetPresentationState(
  presentation: Pick<
    MandelHowlUiSnapshot,
    "datasetStatus" | "renderer" | "runtime"
  >,
): MandelHowlDatasetPresentationState {
  if (presentation.datasetStatus !== "verified") {
    return presentation.datasetStatus;
  }
  const renderer = presentation.renderer;
  return renderer !== null &&
    !renderer.contextLost &&
    renderer.datasetId === presentation.runtime.datasetId &&
    renderer.textureReady
    ? "verified"
    : "streaming";
}

export interface MandelHowlUiSnapshotReadable {
  subscribe(consumer: (snapshot: MandelHowlUiSnapshot) => void): () => void;
  getSnapshot(): MandelHowlUiSnapshot;
}

export interface MandelHowlViewAttachment {
  /** Detaches only this view. It never disposes the shared browser session. */
  detach(): void;
  /**
   * Optional view-local renderer availability channel.
   *
   * The canonical session owns renderer execution, so failures can occur
   * outside a framework event handler. The N-version supervisor subscribes to
   * this channel and treats a failed visible attachment as a view availability
   * failure without granting the view any session-disposal authority.
   */
  subscribeAvailabilityFailure?(
    consumer: (error: unknown) => void,
  ): () => void;
}

export interface MandelHowlBrowserRuntimePort {
  readonly contractVersion: "mandelhowl.ui-port.v1";
  readonly snapshots: RuntimeSnapshotReadable;
  readonly presentation: MandelHowlUiSnapshotReadable;
  mountPlate(canvas: HTMLCanvasElement): MandelHowlViewAttachment;
  dispatchDial(command: DialCommand): void;
  setDragging(dragging: boolean): void;
  activateAudio(): Promise<boolean>;
}

/**
 * Owner capability is deliberately separate from the UI port. A failed
 * React/Svelte candidate can detach its own canvas and subscriptions, but
 * cannot tear down the canonical runtime, audio graph or dataset lifecycle.
 */
export interface MandelHowlBrowserSessionOwner {
  dispose(): void;
}

/**
 * Framework-neutral owned-snapshot store.
 *
 * React can subscribe from an effect, while Svelte 5 can consume this object
 * directly as a readable store. Neither framework receives the reusable
 * renderer/audio lease.
 */
export class RuntimeSnapshotStore implements RuntimeSnapshotReadable {
  private current: RuntimeSnapshot;
  private readonly fanout: RuntimeSnapshotFanout;
  private readonly onConsumerError?: (
    error: unknown,
    snapshot: RuntimeSnapshot,
  ) => void;

  constructor(
    initialSnapshot: RuntimeSnapshot,
    consumers: readonly SnapshotConsumer[] = [],
    onConsumerError?: (error: unknown, snapshot: RuntimeSnapshot) => void,
  ) {
    this.current = initialSnapshot;
    this.fanout = new RuntimeSnapshotFanout(consumers, onConsumerError);
    this.onConsumerError = onConsumerError;
  }

  get metrics(): SnapshotFanoutMetrics {
    return this.fanout.metrics;
  }

  getSnapshot(): RuntimeSnapshot {
    return this.current;
  }

  subscribe(consumer: SnapshotConsumer): () => void {
    // Register first so a synchronous publish triggered by the initial
    // delivery cannot be missed by the new subscriber.
    const unsubscribe = this.fanout.subscribe(consumer);
    try {
      consumer(this.current);
    } catch (error) {
      // An initial-delivery failure must not strand a permanently failing
      // subscriber in the fanout when subscribe cannot return its cleanup.
      unsubscribe();
      try {
        this.onConsumerError?.(error, this.current);
      } catch {
        // Observability must never make subscription cleanup fail.
      }
      return () => {};
    }
    return unsubscribe;
  }

  publish(snapshot: RuntimeSnapshot): boolean {
    return this.fanout.publish(snapshot, (acceptedSnapshot) => {
      // Commit before notifying. Subscribers may safely call getSnapshot()
      // from their callback, including React useSyncExternalStore adapters.
      this.current = acceptedSnapshot;
    });
  }

  dispose(): void {
    this.fanout.dispose();
  }
}

export class MandelHowlUiSnapshotStore
  implements MandelHowlUiSnapshotReadable
{
  private current: MandelHowlUiSnapshot;
  private readonly consumers = new Set<
    (snapshot: MandelHowlUiSnapshot) => void
  >();
  private readonly onConsumerError?: (
    error: unknown,
    snapshot: MandelHowlUiSnapshot,
  ) => void;

  constructor(
    initial: MandelHowlUiSnapshot,
    onConsumerError?: (
      error: unknown,
      snapshot: MandelHowlUiSnapshot,
    ) => void,
  ) {
    this.current = initial;
    this.onConsumerError = onConsumerError;
  }

  getSnapshot(): MandelHowlUiSnapshot {
    return this.current;
  }

  subscribe(consumer: (snapshot: MandelHowlUiSnapshot) => void): () => void {
    this.consumers.add(consumer);
    try {
      consumer(this.current);
    } catch (error) {
      this.consumers.delete(consumer);
      this.reportConsumerError(error, this.current);
      return () => {};
    }
    return () => {
      this.consumers.delete(consumer);
    };
  }

  publish(snapshot: MandelHowlUiSnapshot): void {
    if (snapshot.revision <= this.current.revision) return;
    this.current = snapshot;
    for (const consumer of Array.from(this.consumers)) {
      try {
        consumer(snapshot);
      } catch (error) {
        // A broken UI version is isolated immediately. Its supervisor receives
        // the diagnostic through the supplied observer and may fail over.
        this.consumers.delete(consumer);
        this.reportConsumerError(error, snapshot);
      }
    }
  }

  dispose(): void {
    this.consumers.clear();
  }

  private reportConsumerError(
    error: unknown,
    snapshot: MandelHowlUiSnapshot,
  ): void {
    try {
      this.onConsumerError?.(error, snapshot);
    } catch {
      // Observability must never compromise session availability.
    }
  }
}
