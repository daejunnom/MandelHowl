import type { RuntimeSnapshot } from "../../contracts/src";
import type {
  RuntimeSnapshotConsumer,
  RuntimeSnapshotLease,
} from "../../resonance-engine/src";

export interface SnapshotFanoutMetrics {
  readonly publishedFrames: number;
  readonly rejectedFrames: number;
  readonly lastSequence: number | null;
  readonly lastDatasetId: string | null;
  readonly consumerCount: number;
}

export type SnapshotConsumer = (snapshot: RuntimeSnapshot) => void;

type SnapshotConsumerErrorObserver<Snapshot> = (
  error: unknown,
  snapshot: Snapshot,
) => void;

function reportConsumerError<Snapshot>(
  observer: SnapshotConsumerErrorObserver<Snapshot> | undefined,
  error: unknown,
  snapshot: Snapshot,
): void {
  try {
    observer?.(error, snapshot);
  } catch {
    // Telemetry must never prevent the remaining consumers from observing the
    // same frame.
  }
}

/**
 * One immutable object is fanned to every presentation consumer exactly once.
 * Consumers may schedule their own work, but none receives a separately
 * reconstructed projection or reads mutable core state.
 */
export class RuntimeSnapshotFanout {
  private readonly consumers = new Set<SnapshotConsumer>();
  private readonly failingConsumers = new WeakSet<SnapshotConsumer>();
  private readonly onConsumerError?: SnapshotConsumerErrorObserver<RuntimeSnapshot>;
  private publishedFrames = 0;
  private rejectedFrames = 0;
  private lastSequence: number | null = null;
  private lastDatasetId: string | null = null;
  private disposed = false;

  constructor(
    consumers: readonly SnapshotConsumer[] = [],
    onConsumerError?: SnapshotConsumerErrorObserver<RuntimeSnapshot>,
  ) {
    consumers.forEach((consumer) => this.consumers.add(consumer));
    this.onConsumerError = onConsumerError;
  }

  get metrics(): SnapshotFanoutMetrics {
    return Object.freeze({
      publishedFrames: this.publishedFrames,
      rejectedFrames: this.rejectedFrames,
      lastSequence: this.lastSequence,
      lastDatasetId: this.lastDatasetId,
      consumerCount: this.consumers.size,
    });
  }

  subscribe(consumer: SnapshotConsumer): () => void {
    if (this.disposed) return () => {};
    this.consumers.add(consumer);
    return () => {
      this.consumers.delete(consumer);
    };
  }

  publish(
    snapshot: RuntimeSnapshot,
    commitBeforeNotify?: (snapshot: RuntimeSnapshot) => void,
  ): boolean {
    if (
      this.disposed ||
      !Number.isInteger(snapshot.sequence) ||
      (this.lastDatasetId === snapshot.datasetId &&
        this.lastSequence !== null &&
        snapshot.sequence <= this.lastSequence)
    ) {
      this.rejectedFrames += 1;
      return false;
    }

    this.lastSequence = snapshot.sequence;
    this.lastDatasetId = snapshot.datasetId;
    this.publishedFrames += 1;
    commitBeforeNotify?.(snapshot);
    for (const consumer of this.consumers) {
      try {
        consumer(snapshot);
        this.failingConsumers.delete(consumer);
      } catch (error) {
        if (!this.failingConsumers.has(consumer)) {
          this.failingConsumers.add(consumer);
          reportConsumerError(this.onConsumerError, error, snapshot);
        }
      }
    }
    return true;
  }

  dispose(): void {
    this.disposed = true;
    this.consumers.clear();
  }
}

/**
 * Synchronous, non-retaining fan-out for the reusable hot-path lease.
 *
 * The caller owns the writer and must finish every consumer before the next
 * write. Consumers must not schedule work, store the lease, or pass it to
 * React. Owned presentation state belongs in `RuntimeSnapshotFanout`.
 */
export class RuntimeSnapshotLeaseFanout {
  private readonly consumers = new Set<RuntimeSnapshotConsumer>();
  private readonly failingConsumers = new WeakSet<RuntimeSnapshotConsumer>();
  private readonly onConsumerError?: SnapshotConsumerErrorObserver<RuntimeSnapshotLease>;
  private publishedFrames = 0;
  private rejectedFrames = 0;
  private lastSequence: number | null = null;
  private lastDatasetId: string | null = null;
  private disposed = false;

  constructor(
    consumers: readonly RuntimeSnapshotConsumer[] = [],
    onConsumerError?: SnapshotConsumerErrorObserver<RuntimeSnapshotLease>,
  ) {
    consumers.forEach((consumer) => this.consumers.add(consumer));
    this.onConsumerError = onConsumerError;
  }

  get metrics(): SnapshotFanoutMetrics {
    return Object.freeze({
      publishedFrames: this.publishedFrames,
      rejectedFrames: this.rejectedFrames,
      lastSequence: this.lastSequence,
      lastDatasetId: this.lastDatasetId,
      consumerCount: this.consumers.size,
    });
  }

  publish(snapshot: RuntimeSnapshotLease): boolean {
    const sequence = snapshot.sequence;
    const datasetId = snapshot.datasetId;
    if (
      this.disposed ||
      !Number.isInteger(sequence) ||
      (this.lastDatasetId === datasetId &&
        this.lastSequence !== null &&
        sequence <= this.lastSequence)
    ) {
      this.rejectedFrames += 1;
      return false;
    }

    // Copy identity primitives before invoking consumers. The lease itself is
    // valid only for this synchronous call and is never retained here.
    this.lastSequence = sequence;
    this.lastDatasetId = datasetId;
    this.publishedFrames += 1;
    for (const consumer of this.consumers) {
      try {
        consumer(snapshot);
        this.failingConsumers.delete(consumer);
      } catch (error) {
        if (!this.failingConsumers.has(consumer)) {
          this.failingConsumers.add(consumer);
          reportConsumerError(this.onConsumerError, error, snapshot);
        }
      }
    }
    return true;
  }

  dispose(): void {
    this.disposed = true;
    this.consumers.clear();
  }
}
