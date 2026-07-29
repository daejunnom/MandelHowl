"use client";

import {
  Component,
  type ReactNode,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  createUiInputEventIdScope,
  type MandelHowlBrowserRuntimePort,
  type UiNVersionImplementation,
  type UiRuntimeInputLease,
  type UiViewMountContext,
} from "../../../packages/browser-runtime/src";
import { N_VERSION_CONTRACT_DIGESTS } from "../../../packages/contracts/src";
import "../../../app/mandelhowl.css";
import { MandelHowlReactApp } from "./MandelHowlReactApp";

export const REACT_UI_IMPLEMENTATION_ID = "react" as const;
export const REACT_UI_IMPLEMENTATION_IDENTITY = Object.freeze({
  id: REACT_UI_IMPLEMENTATION_ID,
  scientificAlgorithmDigest: N_VERSION_CONTRACT_DIGESTS.scientificAlgorithm,
  presentationContractDigest: N_VERSION_CONTRACT_DIGESTS.presentationContract,
});

interface BoundaryProps {
  readonly children: ReactNode;
  readonly onError: (error: unknown) => void;
}

class ReactAvailabilityBoundary extends Component<BoundaryProps> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error): void {
    this.props.onError(error);
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

function adaptRuntimeLease(
  lease: UiRuntimeInputLease,
): MandelHowlBrowserRuntimePort {
  const inputIds = createUiInputEventIdScope(
    `${REACT_UI_IMPLEMENTATION_ID}:${lease.generation}`,
  );
  return Object.freeze({
    contractVersion: lease.contractVersion,
    snapshots: lease.snapshots,
    presentation: lease.presentation,
    mountPlate: (canvas: HTMLCanvasElement) => lease.mountPlate(canvas),
    dispatchDial: (
      command: Parameters<MandelHowlBrowserRuntimePort["dispatchDial"]>[0],
    ) => {
      lease.dispatchDial(command, inputIds.forCommand(command));
    },
    setDragging: (dragging: boolean) => {
      lease.setDragging(dragging, inputIds.related());
    },
    activateAudio: () => lease.activateAudio(inputIds.related()),
  });
}

function mountReactCandidate(context: UiViewMountContext) {
  let root: Root | null = createRoot(context.target);
  const runtime = adaptRuntimeLease(context.runtime);
  root.render(
    <ReactAvailabilityBoundary
      onError={(error) => context.reportAvailabilityFailure("view", error)}
    >
      <MandelHowlReactApp
        runtime={runtime}
        onReady={context.reportReady}
        onHeartbeat={context.reportHeartbeat}
        onAvailabilityFailure={(error) =>
          context.reportAvailabilityFailure("view", error)
        }
      />
    </ReactAvailabilityBoundary>,
  );
  return Object.freeze({
    detachView() {
      const mountedRoot = root;
      root = null;
      mountedRoot?.unmount();
    },
  });
}

export function createReactUiImplementation(): UiNVersionImplementation {
  return Object.freeze({
    ...REACT_UI_IMPLEMENTATION_IDENTITY,
    mount: mountReactCandidate,
  });
}
