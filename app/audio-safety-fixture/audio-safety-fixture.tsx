"use client";

import { useEffect, useState } from "react";
import {
  renderOfflineAudioSafetySweep,
  type OfflineAudioSafetySweep,
} from "@/packages/audio-engine/src";

export function AudioSafetyFixture() {
  const [result, setResult] =
    useState<OfflineAudioSafetySweep | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void renderOfflineAudioSafetySweep()
      .then((sweep) => {
        if (active) setResult(sweep);
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setError(reason instanceof Error ? reason.message : "unknown");
      });
    return () => {
      active = false;
    };
  }, []);

  const status = error ? "error" : result ? "ready" : "running";
  return (
    <main>
      <h1>Offline audio safety sweep</h1>
      <output data-testid="audio-safety-sweep" data-status={status}>
        {error ?? (result ? JSON.stringify(result) : "Rendering")}
      </output>
    </main>
  );
}
