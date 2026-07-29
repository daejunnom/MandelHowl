import { mount, unmount } from "svelte";
import {
  createUiInputEventIdScope,
  type MandelHowlBrowserRuntimePort,
  type UiNVersionImplementation,
  type UiRuntimeInputLease,
  type UiViewMountContext,
  type UiViewSession,
} from "../../../packages/browser-runtime/src";
import { N_VERSION_CONTRACT_DIGESTS } from "../../../packages/contracts/src";
import "../../../app/mandelhowl.css";
import MandelHowlApp from "./MandelHowlApp.svelte";

export const SVELTE_UI_IMPLEMENTATION_ID = "svelte5" as const;
export const SVELTE_UI_IMPLEMENTATION_IDENTITY = Object.freeze({
  id: SVELTE_UI_IMPLEMENTATION_ID,
  scientificAlgorithmDigest: N_VERSION_CONTRACT_DIGESTS.scientificAlgorithm,
  presentationContractDigest: N_VERSION_CONTRACT_DIGESTS.presentationContract,
});

export interface MountMandelHowlSvelteOptions {
  readonly target: HTMLElement;
  readonly runtime: MandelHowlBrowserRuntimePort;
  readonly signal?: AbortSignal;
  readonly onReady?: () => void;
  readonly onCommit?: (sequence: number) => void;
  readonly onError?: (error: unknown) => void;
}

export interface MountedMandelHowlSvelteView {
  /** Detaches only the Svelte view; the shared browser runtime remains alive. */
  readonly destroy: () => void;
}

function adaptRuntimeLease(
  lease: UiRuntimeInputLease,
): MandelHowlBrowserRuntimePort {
  const inputIds = createUiInputEventIdScope(
    `${SVELTE_UI_IMPLEMENTATION_ID}:${lease.generation}`,
  );

  const port: MandelHowlBrowserRuntimePort = {
    contractVersion: lease.contractVersion,
    snapshots: lease.snapshots,
    presentation: lease.presentation,
    mountPlate: (canvas: HTMLCanvasElement) => lease.mountPlate(canvas),
    dispatchDial: (command) => {
      lease.dispatchDial(command, inputIds.forCommand(command));
    },
    setDragging: (dragging) => {
      lease.setDragging(dragging, inputIds.related());
    },
    activateAudio: () => lease.activateAudio(inputIds.related()),
  };
  return Object.freeze(port);
}

/**
 * Imperative production entry used by the N-version bootstrap.
 *
 * The caller owns the target and canonical runtime. This function owns only a
 * Svelte component instance and its view-scoped subscriptions/plate lease.
 */
export function mountMandelHowlSvelte(
  options: MountMandelHowlSvelteOptions,
): MountedMandelHowlSvelteView {
  const { target, runtime, signal, onReady, onCommit, onError } = options;
  if (signal?.aborted) {
    throw (
      signal.reason ??
      new DOMException("Svelte view mount aborted", "AbortError")
    );
  }
  if (runtime.contractVersion !== "mandelhowl.ui-port.v1") {
    throw new Error(
      `Unsupported MandelHowl UI port: ${String(runtime.contractVersion)}`,
    );
  }

  let destroyed = false;
  let instance: ReturnType<typeof mount> | null = null;
  let removeAbortListener = () => {};

  const reportError = (error: unknown) => {
    try {
      onError?.(error);
    } catch {
      // A broken availability observer must not escape into Svelte internals.
    }
  };

  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    removeAbortListener();
    const mountedInstance = instance;
    instance = null;
    if (!mountedInstance) return;
    try {
      void unmount(mountedInstance).catch(reportError);
    } catch (error) {
      reportError(error);
    }
  };

  try {
    instance = mount(MandelHowlApp, {
      target,
      props: {
        runtime,
        onReady: () => {
          if (!destroyed) onReady?.();
        },
        onHeartbeat: (sequence: number) => {
          if (!destroyed) onCommit?.(sequence);
        },
        onAvailabilityFailure: (error: unknown) => {
          if (!destroyed) reportError(error);
        },
      },
    });
  } catch (error) {
    reportError(error);
    destroy();
    throw error;
  }

  if (signal) {
    const abort = () => destroy();
    signal.addEventListener("abort", abort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", abort);
    if (signal.aborted) destroy();
  }

  return Object.freeze({ destroy });
}

/**
 * Creates the independently loadable Svelte candidate for UiNVersionSupervisor.
 *
 * Identity digests are compiled into this candidate from the generated
 * contracts. The supervisor compares them with its independently declared
 * definition before granting the generation-scoped runtime lease.
 */
export function createSvelteUiImplementation(): UiNVersionImplementation {
  return Object.freeze({
    ...SVELTE_UI_IMPLEMENTATION_IDENTITY,
    mount(context: UiViewMountContext) {
      return mountSvelteCandidate(context);
    },
  });
}

function mountSvelteCandidate(context: UiViewMountContext): UiViewSession {
  const mounted = mountMandelHowlSvelte({
    target: context.target,
    runtime: adaptRuntimeLease(context.runtime),
    signal: context.signal,
    onReady: context.reportReady,
    onCommit: context.reportHeartbeat,
    onError: (error) => context.reportAvailabilityFailure("view", error),
  });
  return Object.freeze({
    detachView: mounted.destroy,
  });
}
