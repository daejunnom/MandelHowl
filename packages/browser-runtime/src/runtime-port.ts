import type { RuntimeSnapshot } from "../../contracts/src";
import type { DialCommand } from "../../dial-engine/src";
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

export interface MandelHowlBrowserRuntimePort {
  readonly snapshots: RuntimeSnapshotReadable;
  mountPlate(canvas: HTMLCanvasElement): void;
  dispatchDial(command: DialCommand): void;
  activateAudio(): Promise<boolean>;
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
