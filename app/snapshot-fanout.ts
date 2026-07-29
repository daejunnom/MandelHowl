import type { RuntimeSnapshot } from "@/packages/contracts/src";

export interface SnapshotFanoutMetrics {
  readonly publishedFrames: number;
  readonly rejectedFrames: number;
  readonly lastSequence: number | null;
  readonly lastDatasetId: string | null;
  readonly consumerCount: number;
}

export type SnapshotConsumer = (snapshot: RuntimeSnapshot) => void;

/**
 * One immutable object is fanned to every presentation consumer exactly once.
 * Consumers may schedule their own work, but none receives a separately
 * reconstructed projection or reads mutable core state.
 */
export class RuntimeSnapshotFanout {
  private readonly consumers = new Set<SnapshotConsumer>();
  private readonly onConsumerError?: (
    error: unknown,
    snapshot: RuntimeSnapshot,
  ) => void;
  private publishedFrames = 0;
  private rejectedFrames = 0;
  private lastSequence: number | null = null;
  private lastDatasetId: string | null = null;
  private disposed = false;

  constructor(
    consumers: readonly SnapshotConsumer[] = [],
    onConsumerError?: (error: unknown, snapshot: RuntimeSnapshot) => void,
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

  publish(snapshot: RuntimeSnapshot): boolean {
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
    for (const consumer of this.consumers) {
      try {
        consumer(snapshot);
      } catch (error) {
        this.onConsumerError?.(error, snapshot);
      }
    }
    return true;
  }

  dispose(): void {
    this.disposed = true;
    this.consumers.clear();
  }
}
