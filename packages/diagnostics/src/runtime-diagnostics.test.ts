import { describe, expect, it } from "vitest";
import type { RuntimeCapabilities } from "./runtime-diagnostics";
import {
  createDiagnostic,
  diagnosticsForCapabilities,
  mergeDiagnostics,
} from "./runtime-diagnostics";
import { presentDiagnostics } from "./diagnostic-presenter";

const FULL_CAPABILITIES: RuntimeCapabilities = {
  render: "webgl2",
  texture: "ktx2-native",
  audio: true,
  offscreenCanvas: true,
  reducedMotion: false,
  forcedColors: false,
  logicalProcessors: 8,
  deviceMemoryGb: 8,
};

describe("runtime diagnostics", () => {
  it("stays silent when production capabilities are present", () => {
    expect(diagnosticsForCapabilities(FULL_CAPABILITIES)).toEqual([]);
  });

  it("reports independent visual and audio fallbacks", () => {
    const records = diagnosticsForCapabilities({
      ...FULL_CAPABILITIES,
      render: "canvas2d",
      texture: "image-fallback",
      audio: false,
    });

    expect(records.map((record) => record.code)).toEqual([
      "MH-CAP-WEBGL2-UNAVAILABLE",
      "MH-CAP-KTX2-FALLBACK",
      "MH-CAP-AUDIO-UNAVAILABLE",
    ]);
  });

  it("deduplicates codes and presents the highest severity first", () => {
    const records = mergeDiagnostics(
      [
        createDiagnostic({
          code: "MH-DATASET-INTEGRITY",
          severity: "warning",
          messageKey: "dataset.integrity",
        }),
      ],
      [
        createDiagnostic({
          code: "MH-DATASET-INTEGRITY",
          severity: "fatal",
          messageKey: "dataset.integrity",
        }),
      ],
    );
    const presented = presentDiagnostics(records);

    expect(records).toHaveLength(1);
    expect(presented.severity).toBe("fatal");
    expect(presented.title).toBe("Dataset verification failed");
  });

  it("redacts secrets and URL query data from developer-facing evidence", () => {
    const presented = presentDiagnostics([
      createDiagnostic({
        code: "DATASET_MANIFEST_FETCH_FAILED",
        severity: "fatal",
        messageKey: "dataset.fetch",
        evidence: [
          {
            key: "url",
            value: "https://example.test/runtime/manifest.json?token=private#x",
            source: "fetch",
          },
          {
            key: "authorizationToken",
            value: "private",
            source: "fetch",
          },
        ],
      }),
    ]);

    expect(presented.developerLines[0]).toContain(
      "https://example.test/runtime/manifest.json",
    );
    expect(presented.developerLines[0]).not.toContain("token=private");
    expect(presented.developerLines[0]).not.toContain("authorizationToken=private");
    expect(presented.developerLines[0]).toContain(
      "authorizationToken=[redacted]",
    );
  });
});
