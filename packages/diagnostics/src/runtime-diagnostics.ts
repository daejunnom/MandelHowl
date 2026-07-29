import type {
  DiagnosticEvidence,
  DiagnosticEvidenceState,
  DiagnosticRecord,
  DiagnosticSeverity,
} from "../../contracts/src/diagnostic-record";

export type RenderCapability = "webgl2" | "canvas2d" | "static";
export type TextureCapability = "ktx2-native" | "image-fallback" | "none";

export interface RuntimeCapabilities {
  readonly render: RenderCapability;
  readonly texture: TextureCapability;
  readonly audio: boolean;
  readonly offscreenCanvas: boolean;
  readonly reducedMotion: boolean;
  readonly forcedColors: boolean;
  readonly logicalProcessors: number | null;
  readonly deviceMemoryGb: number | null;
}

export interface DiagnosticInput {
  readonly code: string;
  readonly severity: DiagnosticSeverity;
  readonly evidenceState?: DiagnosticEvidenceState;
  readonly messageKey: string;
  readonly evidence?: readonly DiagnosticEvidence[];
}

export function createDiagnostic(input: DiagnosticInput): DiagnosticRecord {
  return Object.freeze({
    code: input.code,
    severity: input.severity,
    evidenceState: input.evidenceState ?? "confirmed",
    messageKey: input.messageKey,
    evidence: Object.freeze([...(input.evidence ?? [])]),
  });
}

function mediaQueryMatches(query: string): boolean {
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function"
    ? window.matchMedia(query).matches
    : false;
}

function probeCanvasContexts(): {
  render: RenderCapability;
  texture: TextureCapability;
} {
  if (typeof document === "undefined") {
    return { render: "static", texture: "none" };
  }

  const webglCanvas = document.createElement("canvas");
  const webgl = webglCanvas.getContext("webgl2", {
    alpha: true,
    antialias: false,
    depth: false,
    powerPreference: "high-performance",
    preserveDrawingBuffer: false,
  });

  if (webgl) {
    const supportsCompressedTexture =
      Boolean(webgl.getExtension("WEBGL_compressed_texture_astc")) ||
      Boolean(webgl.getExtension("EXT_texture_compression_bptc")) ||
      Boolean(webgl.getExtension("WEBGL_compressed_texture_etc"));
    const loseContext = webgl.getExtension("WEBGL_lose_context");
    loseContext?.loseContext();
    return {
      render: "webgl2",
      texture: supportsCompressedTexture
        ? "ktx2-native"
        : "image-fallback",
    };
  }

  const canvas2d = document.createElement("canvas").getContext("2d");
  return {
    render: canvas2d ? "canvas2d" : "static",
    texture: canvas2d ? "image-fallback" : "none",
  };
}

export function probeRuntimeCapabilities(): RuntimeCapabilities {
  const canvas = probeCanvasContexts();
  const navigatorWithMemory =
    typeof navigator === "undefined"
      ? null
      : (navigator as Navigator & { deviceMemory?: number });
  const AudioContextConstructor =
    typeof window === "undefined"
      ? undefined
      : window.AudioContext ??
        (
          window as typeof window & {
            webkitAudioContext?: typeof AudioContext;
          }
        ).webkitAudioContext;

  return Object.freeze({
    render: canvas.render,
    texture: canvas.texture,
    audio: Boolean(AudioContextConstructor),
    offscreenCanvas: typeof OffscreenCanvas !== "undefined",
    reducedMotion: mediaQueryMatches("(prefers-reduced-motion: reduce)"),
    forcedColors: mediaQueryMatches("(forced-colors: active)"),
    logicalProcessors:
      navigatorWithMemory &&
      Number.isFinite(navigatorWithMemory.hardwareConcurrency)
        ? navigatorWithMemory.hardwareConcurrency
        : null,
    deviceMemoryGb:
      navigatorWithMemory &&
      Number.isFinite(navigatorWithMemory.deviceMemory)
        ? navigatorWithMemory.deviceMemory ?? null
        : null,
  });
}

export function diagnosticsForCapabilities(
  capabilities: RuntimeCapabilities,
): readonly DiagnosticRecord[] {
  const diagnostics: DiagnosticRecord[] = [];

  if (capabilities.render === "canvas2d") {
    diagnostics.push(
      createDiagnostic({
        code: "MH-CAP-WEBGL2-UNAVAILABLE",
        severity: "warning",
        messageKey: "render.webgl2Unavailable",
        evidence: [
          {
            key: "selectedRenderer",
            value: "canvas2d",
            source: "runtime-capability-probe",
          },
        ],
      }),
    );
  } else if (capabilities.render === "static") {
    diagnostics.push(
      createDiagnostic({
        code: "MH-CAP-CANVAS-UNAVAILABLE",
        severity: "fatal",
        messageKey: "render.canvasUnavailable",
        evidence: [
          {
            key: "selectedRenderer",
            value: "static-css",
            source: "runtime-capability-probe",
          },
        ],
      }),
    );
  }

  if (capabilities.texture !== "ktx2-native") {
    diagnostics.push(
      createDiagnostic({
        code: "MH-CAP-KTX2-FALLBACK",
        severity: "info",
        messageKey: "render.ktx2Fallback",
        evidence: [
          {
            key: "textureCapability",
            value: capabilities.texture,
            source: "runtime-capability-probe",
          },
        ],
      }),
    );
  }

  if (!capabilities.audio) {
    diagnostics.push(
      createDiagnostic({
        code: "MH-CAP-AUDIO-UNAVAILABLE",
        severity: "warning",
        messageKey: "audio.unavailable",
        evidence: [
          {
            key: "audioContext",
            value: false,
            source: "runtime-capability-probe",
          },
        ],
      }),
    );
  }

  return Object.freeze(diagnostics);
}

export function mergeDiagnostics(
  ...groups: readonly (readonly DiagnosticRecord[])[]
): readonly DiagnosticRecord[] {
  const byCode = new Map<string, DiagnosticRecord>();
  for (const group of groups) {
    for (const diagnostic of group) {
      const existing = byCode.get(diagnostic.code);
      if (
        !existing ||
        severityRank(diagnostic.severity) > severityRank(existing.severity)
      ) {
        byCode.set(diagnostic.code, diagnostic);
      }
    }
  }
  return Object.freeze([...byCode.values()]);
}

function severityRank(severity: DiagnosticSeverity): number {
  if (severity === "fatal") return 3;
  if (severity === "warning") return 2;
  return 1;
}
