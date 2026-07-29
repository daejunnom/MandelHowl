import { describe, expect, it, vi } from "vitest";
import {
  activeMode,
  createPlateTexturePreviewQueue,
} from "../../app/mandelhowl-lab";
import type { RuntimeSnapshot } from "../../packages/contracts/src";
import type { VerifiedAssetProgressEvent } from "../../packages/asset-runtime/src";
import type { PlateTextureSource } from "../../packages/render-engine/src";

const DATASET_ID = `sha256:${"a".repeat(64)}` as const;

function progressEvent(
  kind: "sand-density" | "normal" = "sand-density",
): VerifiedAssetProgressEvent {
  return {
    schemaVersion: "mandelhowl.asset-progress.v1",
    datasetId: DATASET_ID,
    datasetReady: false,
    path: `textures/${kind}.ktx2`,
    url: `https://example.test/runtime/${kind}.ktx2?sha256=abc`,
    mediaType: "image/ktx2",
    byteLength: 4,
    sha256: "b".repeat(64),
    textureKind: kind,
    texture: {
      kind,
      modeIds: ["mode-001", "mode-002"],
      widthPx: 128,
      heightPx: 128,
      layers: 2,
      uvOrigin: "negative-x-negative-y",
    },
    verifiedCount: 3,
    totalCount: 10,
    bytes: new Uint8Array([1, 2, 3, 4]),
  };
}

describe("production sand texture preview queue", () => {
  it("presents the immediate capture identity instead of residual dominance", () => {
    const snapshot = {
      activeModeId: "new",
      modes: [
        {
          modeId: "old",
          phaseRad: 0.25,
          energyNormalized: 0.9,
        },
        {
          modeId: "new",
          phaseRad: 1.75,
          energyNormalized: 0.1,
        },
      ],
    } as unknown as RuntimeSnapshot;
    expect(activeMode(snapshot)).toEqual({
      index: 1,
      phase: 1.75,
    });
    expect(
      activeMode({
        ...snapshot,
        activeModeId: null,
      }),
    ).toEqual({ index: null, phase: 0 });
  });

  it("keeps canonical identity for final reuse without remapping mode IDs", async () => {
    const setTextureSource = vi.fn<
      (source: PlateTextureSource | null) => Promise<void>
    >(async () => {});
    const queue = createPlateTexturePreviewQueue({ setTextureSource });
    const sand = progressEvent("sand-density");

    queue.onAssetVerified(progressEvent("normal"));
    queue.onAssetVerified(sand);
    await queue.waitForIdle();

    expect(setTextureSource).toHaveBeenCalledTimes(1);
    const source = setTextureSource.mock.calls[0]?.[0];
    expect(source).toMatchObject({
      datasetId: DATASET_ID,
      atlases: [
        {
          kind: "sand-density",
          modeIds: ["mode-001", "mode-002"],
          width: 128,
          height: 128,
          layers: 2,
        },
      ],
    });
    expect(source?.atlases[0]?.bytes).toBe(sand.bytes);
  });

  it("waits for asynchronous upload and contains preview rejection", async () => {
    let finishUpload: (() => void) | undefined;
    const setTextureSource = vi.fn<
      (source: PlateTextureSource | null) => Promise<void>
    >(
      () =>
        new Promise<void>((resolve) => {
          finishUpload = resolve;
        }),
    );
    const queue = createPlateTexturePreviewQueue({ setTextureSource });

    queue.onAssetVerified(progressEvent());
    let idle = false;
    const waiting = queue.waitForIdle().then(() => {
      idle = true;
    });
    await Promise.resolve();
    expect(idle).toBe(false);
    finishUpload?.();
    await waiting;
    expect(idle).toBe(true);

    const rejecting = createPlateTexturePreviewQueue({
      setTextureSource: vi.fn<
        (source: PlateTextureSource | null) => Promise<void>
      >(async () => {
        throw new Error("decode failed");
      }),
    });
    rejecting.onAssetVerified(progressEvent());
    await expect(rejecting.waitForIdle()).resolves.toBeUndefined();
  });

  it("ignores duplicate progress and work queued before disposal", async () => {
    const setTextureSource = vi.fn<
      (source: PlateTextureSource | null) => Promise<void>
    >(async () => {});
    const queue = createPlateTexturePreviewQueue({ setTextureSource });

    queue.onAssetVerified(progressEvent());
    queue.onAssetVerified(progressEvent());
    queue.dispose();
    await queue.waitForIdle();

    expect(setTextureSource).not.toHaveBeenCalled();
    queue.onAssetVerified(progressEvent());
    await queue.waitForIdle();
    expect(setTextureSource).not.toHaveBeenCalled();
  });
});
