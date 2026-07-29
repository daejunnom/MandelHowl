import type { UiNVersionState } from "./ui-nversion-supervisor";

export interface UiNVersionHealthHook {
  readonly getSnapshot: () => UiNVersionState;
}

declare global {
  interface Window {
    __MANDELHOWL_UI_HEALTH__?: UiNVersionHealthHook;
  }
}

/** Installs a read-only UI selection hook for soak and failover tests. */
export function installUiNVersionHealthHook(
  getSnapshot: () => UiNVersionState,
): () => void {
  if (typeof window === "undefined") return () => {};
  const hook = Object.freeze({ getSnapshot });
  Object.defineProperty(window, "__MANDELHOWL_UI_HEALTH__", {
    configurable: true,
    enumerable: false,
    writable: false,
    value: hook,
  });
  return () => {
    if (window.__MANDELHOWL_UI_HEALTH__ === hook) {
      delete window.__MANDELHOWL_UI_HEALTH__;
    }
  };
}
