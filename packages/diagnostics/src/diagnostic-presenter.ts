import type {
  DiagnosticRecord,
  DiagnosticSeverity,
} from "../../contracts/src/diagnostic-record";

export interface PresentedDiagnostics {
  readonly severity: DiagnosticSeverity | "none";
  readonly title: string;
  readonly message: string;
  readonly recovery: string | null;
  readonly developerLines: readonly string[];
}

const USER_COPY: Readonly<
  Record<
    string,
    { title: string; message: string; recovery: string | null }
  >
> = {
  "MH-CAP-WEBGL2-UNAVAILABLE": {
    title: "Canvas fallback active",
    message:
      "The plate remains driven by the same simulation snapshot at a lower visual quality.",
    recovery: null,
  },
  "MH-CAP-CANVAS-UNAVAILABLE": {
    title: "Plate visualization unavailable",
    message:
      "The frequency, feedback state and virtual volume remain available as text.",
    recovery: "Try a browser with Canvas or WebGL2 enabled.",
  },
  "MH-CAP-KTX2-FALLBACK": {
    title: "Texture fallback active",
    message:
      "A verified fallback surface is being used without changing the feedback calculation.",
    recovery: null,
  },
  "MH-CAP-AUDIO-UNAVAILABLE": {
    title: "Monitor muted",
    message:
      "The virtual experiment still runs; only the independently limited listening monitor is unavailable.",
    recovery: null,
  },
  "MH-DATASET-PENDING": {
    title: "Loading modal plate data",
    message:
      "The deterministic analytical preview is shown until the verified dataset is ready.",
    recovery: null,
  },
  "MH-DATASET-PROTOTYPE": {
    title: "Analytical prototype",
    message:
      "This plate view exercises the production runtime boundary but is not presented as a finite-element result.",
    recovery: null,
  },
  "MH-DATASET-INTEGRITY": {
    title: "Dataset verification failed",
    message:
      "Unverified textures were rejected. The deterministic analytical fallback remains active.",
    recovery: "Reload to retry the content-addressed dataset.",
  },
  "MH-RENDER-CONTEXT-LOST": {
    title: "Renderer recovering",
    message:
      "The plate view paused while the graphics context is restored. The simulation and volume are unchanged.",
    recovery: null,
  },
  "MH-AUDIO-INVALID-SNAPSHOT": {
    title: "Monitor muted for safety",
    message:
      "An invalid audio control value was rejected without changing the virtual volume result.",
    recovery: "Move the frequency dial again to resume a valid signal.",
  },
  "MH-AUDIO-SAFETY-GUARD": {
    title: "Exposure guard active",
    message:
      "The listening monitor was attenuated while the virtual feedback state continues unchanged.",
    recovery: null,
  },
  "MH-AUDIO-GRAPH-FAILED": {
    title: "Monitor unavailable",
    message:
      "The listening graph could not be created, so it remained muted while the virtual experiment continued.",
    recovery: "Reload or continue with the visual instrument.",
  },
  "MH-AUDIO-RESUME-FAILED": {
    title: "Monitor paused",
    message:
      "The browser did not resume the listening graph. The virtual result is unchanged.",
    recovery: "Move the dial again or continue muted.",
  },
};

function rank(severity: DiagnosticSeverity): number {
  if (severity === "fatal") return 3;
  if (severity === "warning") return 2;
  return 1;
}

function sanitizeEvidenceValue(
  key: string,
  value: string | number | boolean | null,
): string {
  if (typeof value !== "string") return String(value);
  if (/token|secret|password|authorization|cookie/i.test(key)) {
    return "[redacted]";
  }
  const withoutUrlDetails = value.replace(
    /https?:\/\/[^\s,]+/gi,
    (candidate) => {
      try {
        const url = new URL(candidate);
        return `${url.origin}${url.pathname}`;
      } catch {
        return "[redacted-url]";
      }
    },
  );
  const withoutQuery =
    /url|uri|origin|referrer/i.test(key)
      ? withoutUrlDetails.replace(/[?#].*$/, "")
      : withoutUrlDetails;
  return withoutQuery.length <= 240
    ? withoutQuery
    : `${withoutQuery.slice(0, 237)}...`;
}

function formatDeveloperLine(record: DiagnosticRecord): string {
  const evidence = record.evidence
    .map(
      (item) =>
        `${item.key}=${sanitizeEvidenceValue(
          item.key,
          item.value,
        )} @ ${item.source}`,
    )
    .join(", ");
  return `${record.code} [${record.severity}/${record.evidenceState}]${
    evidence ? ` ${evidence}` : ""
  }`;
}

function copyForDiagnostic(record: DiagnosticRecord) {
  const direct = USER_COPY[record.code];
  if (direct) return direct;
  if (record.code === "DATASET_READY") {
    return {
      title: "Dataset verified",
      message:
        "The content-addressed modal data and its referenced assets passed browser integrity checks.",
      recovery: null,
    };
  }
  if (record.code.startsWith("DATASET_")) {
    return {
      title: "Dataset verification failed",
      message:
        "Unverified production data was rejected. The explicitly labelled analytical prototype remains active.",
      recovery: "Reload to retry the content-addressed dataset.",
    };
  }
  return {
    title: record.severity === "fatal" ? "Experiment paused" : "System notice",
    message:
      "A runtime diagnostic is available. The virtual result is not inferred from the visual fallback.",
    recovery: null,
  };
}

export function presentDiagnostics(
  records: readonly DiagnosticRecord[],
): PresentedDiagnostics {
  if (records.length === 0) {
    return Object.freeze({
      severity: "none",
      title: "System verified",
      message: "No runtime capability or integrity warnings.",
      recovery: null,
      developerLines: Object.freeze([]),
    });
  }

  const ordered = [...records].sort(
    (a, b) => rank(b.severity) - rank(a.severity),
  );
  const primary = ordered[0];
  const copy = copyForDiagnostic(primary);

  return Object.freeze({
    severity: primary.severity,
    ...copy,
    developerLines: Object.freeze(ordered.map(formatDeveloperLine)),
  });
}
