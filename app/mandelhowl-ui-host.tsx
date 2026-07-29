"use client";

import { useEffect, useState } from "react";
import {
  N_VERSION_CONTRACT_DIGESTS,
  type DiagnosticRecord,
} from "@/packages/contracts/src";
import {
  installUiNVersionHealthHook,
  UiNVersionSupervisor,
  type MandelHowlBrowserRuntimePort,
  type UiNVersionImplementation,
  type UiNVersionPhase,
  type UiViewMountContext,
} from "@/packages/browser-runtime/src";

interface MandelHowlUiHostProps {
  readonly runtime: MandelHowlBrowserRuntimePort;
  readonly onDiagnostic?: (diagnostic: DiagnosticRecord) => void;
  readonly onAllVersionsUnavailable?: () => void;
}

interface HostState {
  readonly phase: UiNVersionPhase;
  readonly activeImplementationId: "svelte5" | "react" | null;
  readonly diagnosticCode: string;
  readonly failoverCount: number;
}

const INITIAL_STATE: HostState = Object.freeze({
  phase: "idle",
  activeImplementationId: null,
  diagnosticCode: "MH-UI-PRIMARY-LOADING",
  failoverCount: 0,
});

function wrapInjectedViewFault(
  implementation: UiNVersionImplementation,
  fault: string | null,
  implementationLabel: string,
): UiNVersionImplementation {
  if (fault === "mount") {
    return Object.freeze({
      ...implementation,
      mount() {
        throw new Error(`Injected ${implementationLabel} mount failure`);
      },
    });
  }
  if (fault !== "runtime" && fault !== "stale") return implementation;

  return Object.freeze({
    ...implementation,
    async mount(context: UiViewMountContext) {
      let faultTimer = 0;
      const wrappedContext: UiViewMountContext = Object.freeze({
        ...context,
        reportReady: () => {
          context.reportReady();
          if (fault === "runtime") {
            faultTimer = window.setTimeout(() => {
              context.reportAvailabilityFailure(
                "view",
                new Error(
                  `Injected ${implementationLabel} runtime failure`,
                ),
              );
            }, 750);
          }
        },
        reportHeartbeat: (sequence: number) => {
          if (fault !== "stale") context.reportHeartbeat(sequence);
        },
      });
      const view = await implementation.mount(wrappedContext);
      return Object.freeze({
        detachView() {
          window.clearTimeout(faultTimer);
          view.detachView();
        },
      });
    },
  });
}

/**
 * Framework-neutral N-version selector hosted by the route bootstrap.
 *
 * Exactly one implementation owns the target DOM. Both candidates receive a
 * generation-scoped lease over the same canonical browser session, so view
 * replacement cannot reset physics, dataset, dial inertia or safe audio.
 */
export function MandelHowlUiHost({
  runtime,
  onDiagnostic,
  onAllVersionsUnavailable,
}: MandelHowlUiHostProps) {
  const [hostState, setHostState] = useState<HostState>(INITIAL_STATE);

  useEffect(() => {
    // A body-level sibling keeps the candidate framework root outside the
    // bootstrap React tree. This avoids nested renderer ownership and makes
    // the two candidate bundles independently mountable.
    const target = document.createElement("div");
    target.className = "mh-ui-version-target";
    target.dataset.mandelhowlUiTarget = "true";
    document.body.append(target);
    const query = new URLSearchParams(window.location.search);
    // Candidate selection is policy-owned in production. The query override
    // remains available to local parity/E2E tests but cannot turn a healthy
    // primary into a fabricated availability failure in a release build.
    const forcedReact =
      process.env.NODE_ENV !== "production" &&
      query.get("mh-ui") === "react";
    const injectedFault =
      process.env.NODE_ENV === "production"
        ? null
        : query.get("mh-ui-fault");
    const injectedStandbyFault =
      process.env.NODE_ENV === "production"
        ? null
        : query.get("mh-ui-standby-fault");
    let hostDisposed = false;
    let unavailableNotified = false;
    const identity = Object.freeze({
      scientificAlgorithmDigest:
        N_VERSION_CONTRACT_DIGESTS.scientificAlgorithm,
      presentationContractDigest:
        N_VERSION_CONTRACT_DIGESTS.presentationContract,
    });

    const supervisor = new UiNVersionSupervisor(runtime, {
      expectedScientificAlgorithmDigest: identity.scientificAlgorithmDigest,
      expectedPresentationContractDigest:
        identity.presentationContractDigest,
      readinessTimeoutMs: 2_000,
      heartbeatTimeoutMs: 4_000,
      shouldMonitorHeartbeat: () =>
        document.visibilityState === "visible",
      primary: {
        id: "svelte5",
        ...identity,
        async load() {
          if (forcedReact || injectedFault === "load") {
            throw new Error(
              forcedReact
                ? "React UI explicitly selected"
                : "Injected Svelte load failure",
            );
          }
          const svelteEntry = await import("@/apps/svelte-ui/src/entry");
          return wrapInjectedViewFault(
            svelteEntry.createSvelteUiImplementation(),
            injectedFault,
            "Svelte",
          );
        },
      },
      standby: {
        id: "react",
        ...identity,
        async load() {
          if (injectedStandbyFault === "load") {
            throw new Error("Injected React load failure");
          }
          const reactEntry = await import("@/apps/react-ui/src/entry");
          return wrapInjectedViewFault(
            reactEntry.createReactUiImplementation(),
            injectedStandbyFault,
            "React",
          );
        },
      },
      onDiagnostic: (diagnostic) => {
        if (hostDisposed) return;
        try {
          onDiagnostic?.(diagnostic);
        } finally {
          setHostState((current) => ({
            ...current,
            diagnosticCode: diagnostic.code,
          }));
        }
      },
      onStateChange: (state) => {
        if (hostDisposed) return;
        if (
          !unavailableNotified &&
          (state.phase === "quarantined" ||
            state.phase === "unavailable")
        ) {
          unavailableNotified = true;
          try {
            onAllVersionsUnavailable?.();
          } catch {
            // Safety notification cannot alter supervisor selection.
          }
        }
        setHostState((current) => {
          const activeImplementationId =
            state.phase === "active"
              ? state.activeImplementationId
              : null;
          if (
            current.phase === state.phase &&
            current.activeImplementationId === activeImplementationId &&
            current.failoverCount === state.failoverCount
          ) {
            return current;
          }
          return {
            ...current,
            phase: state.phase,
            activeImplementationId,
            failoverCount: state.failoverCount,
          };
        });
      },
    });
    const removeHealthHook = installUiNVersionHealthHook(() =>
      supervisor.getSnapshot(),
    );
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        supervisor.notifyLifecyclePause();
      } else {
        supervisor.notifyLifecycleResume();
      }
    };
    const onPageShow = () => {
      if (document.visibilityState === "visible") {
        supervisor.notifyLifecycleResume();
      }
    };
    const onPageHide = () => supervisor.notifyLifecyclePause();
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("pagehide", onPageHide);

    void supervisor.start(target);
    return () => {
      hostDisposed = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("pagehide", onPageHide);
      removeHealthHook();
      supervisor.disposeView();
      target.replaceChildren();
      target.remove();
    };
  }, [onAllVersionsUnavailable, onDiagnostic, runtime]);

  const fatal =
    hostState.phase === "quarantined" ||
    hostState.phase === "unavailable";

  return (
    <div
      className="mh-ui-nversion-host"
      data-active-ui={hostState.activeImplementationId ?? "none"}
      data-ui-phase={hostState.phase}
      data-ui-diagnostic-code={hostState.diagnosticCode}
      data-ui-failover-count={hostState.failoverCount}
    >
      {!hostState.activeImplementationId && !fatal ? (
        <main className="mh-ui-loading" role="status" aria-live="polite">
          <strong>MandelHowl</strong>
          <span>Loading verified instrument interface…</span>
        </main>
      ) : null}
      {fatal ? (
        <main className="mh-ui-fatal" role="alert">
          <strong>MandelHowl UI unavailable</strong>
          <p>
            Both presentation versions were isolated; audio was safely
            suspended.
          </p>
          <code>{hostState.diagnosticCode}</code>
        </main>
      ) : null}
    </div>
  );
}
