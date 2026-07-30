import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { decodeModesBinaryV1 } from "../../packages/asset-runtime/src";
import {
  GENERATED_DATASET_RELEASE_SPEC,
  GENERATED_SCENE_SPEC,
  GENERATED_VOLUME_MAP_SPEC,
  formatFrequencyHz,
  toCentiHertz,
} from "../../packages/contracts/src";
import {
  MandelHowlScene,
  type MandelHowlSceneProps,
} from "../../app/mandelhowl-scene";

const noOp = () => undefined;
const REACT_SCENE_SOURCE = readFileSync(
  resolve(process.cwd(), "app/mandelhowl-scene.tsx"),
  "utf8",
);
const REACT_ADAPTER_SOURCE = readFileSync(
  resolve(
    process.cwd(),
    "apps/react-ui/src/MandelHowlReactApp.tsx",
  ),
  "utf8",
);
const SVELTE_SCENE_SOURCE = readFileSync(
  resolve(
    process.cwd(),
    "apps/svelte-ui/src/MandelHowlApp.svelte",
  ),
  "utf8",
);
const PINNED_MODES = decodeModesBinaryV1(
  readFileSync(
    resolve(
      process.cwd(),
      GENERATED_DATASET_RELEASE_SPEC.sourceDirectory,
      "modes.bin",
    ),
  ),
);
const PRESENTATION_MODE_INDEX = Math.round(
  (PINNED_MODES.length - 1) * 0.75,
);
const PRESENTATION_FREQUENCY =
  PINNED_MODES[PRESENTATION_MODE_INDEX]?.naturalFrequencyHz;
if (PRESENTATION_FREQUENCY === undefined) {
  throw new Error("The pinned presentation fixture mode is unavailable.");
}

function formatExpectedFrequency(frequency: number): string {
  return formatFrequencyHz(frequency);
}

function renderScene(
  overrides: Partial<MandelHowlSceneProps> = {},
): string {
  return renderToStaticMarkup(
    createElement(MandelHowlScene, {
      frequencyCentiHz: toCentiHertz(PRESENTATION_FREQUENCY),
      frequency: PRESENTATION_FREQUENCY,
      angle: 0,
      volume: 50,
      regime: "critical",
      envelope: 0.48,
      activeMode: PRESENTATION_MODE_INDEX,
      measurementProgress: 1,
      measurementStatus: "settled",
      microphoneRms: 0.31,
      microphonePeak: 0.5,
      microphoneSamples: [0, 0.01, -0.02, 0.015],
      audioEnabled: false,
      dragging: false,
      onDialPointerDown: noOp,
      onDialPointerMove: noOp,
      onDialPointerUp: noOp,
      onDialPointerCancel: noOp,
      onDialKeyDown: noOp,
      onDialWheel: noOp,
      canvasRef: noOp,
      ...overrides,
    }),
  );
}

describe("instrument presentation", () => {
  it("makes a quiet physical waveform legible without changing its input", () => {
    const physicalSamples = Object.freeze([0, 0.01, -0.02, 0.015]);
    const html = renderScene({ microphoneSamples: physicalSamples });

    expect(physicalSamples).toEqual([0, 0.01, -0.02, 0.015]);
    expect(html).toContain('data-auto-gain="39.000"');
    expect(html).toContain('data-display-peak="0.780"');
    expect(html).toContain("--scope-magnitude:0.78");
    expect(html).toContain("AUTO ×39");
    expect(html).toContain('data-polarity="negative"');
    expect(html.match(/class="mh-scope-sample"/g)).toHaveLength(20);
    expect(html).toContain(
      'aria-label="Microphone waveform; RMS 31 percent, peak 50 percent"',
    );
  });

  it("keeps the dial frequency unobstructed by decorative center markup", () => {
    const html = renderScene();

    expect(html).toContain(formatExpectedFrequency(PRESENTATION_FREQUENCY));
    expect(html).not.toContain("mh-dial-cap");
  });

  it("renders canonical centihertz in text and raw ARIA without kHz loss", () => {
    const cases = [
      [4_500, "45.00"],
      [68_319, "683.19"],
      [100_000, "1000.00"],
      [600_000, "6000.00"],
    ] as const;

    for (const [frequencyCentiHz, decimal] of cases) {
      const html = renderScene({
        frequencyCentiHz,
        frequency: frequencyCentiHz / 100,
      });
      const ariaNumeric = String(frequencyCentiHz / 100);

      expect(html).toContain(`>${decimal} Hz</strong>`);
      expect(html).toContain(
        `aria-valuenow="${ariaNumeric}"`,
      );
      expect(html).toContain(
        `aria-valuetext="${decimal} Hz, critical"`,
      );
      expect(html).not.toContain("aria-keyshortcuts");
      expect(html).not.toContain("kHz</strong>");
    }
  });

  it("keeps React and Svelte on the shared exact frequency and ARIA contract", () => {
    for (const source of [
      REACT_SCENE_SOURCE,
      SVELTE_SCENE_SOURCE,
    ]) {
      expect(source).toContain("formatDriveFrequencyCentiHz");
      expect(source).toContain(
        "fromCentiHertz(frequencyCentiHz)",
      );
      expect(source).toMatch(
        /aria-valuenow=\{fromCentiHertz\(frequencyCentiHz\)\}/,
      );
      expect(source).not.toContain("aria-keyshortcuts");
      expect(source).not.toContain(
        "aria-valuenow={Math.round(frequency)}",
      );
      expect(source).not.toMatch(/function formatFrequency\(/);
    }

    for (const source of [
      REACT_ADAPTER_SOURCE,
      SVELTE_SCENE_SOURCE,
    ]) {
      expect(source).toMatch(
        /createDialKeyboardCommand\(\s*event\.key,\s*event\.timeStamp,\s*event\.shiftKey,\s*\)/,
      );
      expect(source).toMatch(
        /if \(command === null\) return;\s*dispatch\(command\);\s*activateAudio\(\);/,
      );
    }
  });

  it("claims the precomputed material cutaway only when the renderer has it", () => {
    const unavailable = renderScene({
      datasetStatus: "verified",
      materialSectionReady: false,
    });
    expect(unavailable).toContain(
      "verified modal dataset without an available material thickness cutaway",
    );
    expect(unavailable).not.toContain(
      "precomputed Mandelbrot material thickness cutaway visible",
    );

    const ready = renderScene({
      datasetStatus: "verified",
      materialSectionReady: true,
    });
    expect(ready).toContain(
      "precomputed Mandelbrot material thickness cutaway visible at the lower plate edge",
    );
  });

  it("uses one microphone scope with a read-only critical phase emphasis", () => {
    const html = renderScene();
    const instrumentation = html.match(
      /<div class="mh-instrumentation"[^>]*>([\s\S]*?)<div class="mh-measurement"/,
    )?.[1];

    expect(instrumentation).toBeDefined();
    expect(instrumentation?.match(/role="img"/g)).toHaveLength(1);
    expect(instrumentation).toContain("mh-oscilloscope");
    expect(instrumentation).toContain("mh-scope-phase-emphasis");
    expect(instrumentation).not.toContain("mh-phase-meter");
    expect(html).toContain("--microphone-level:0.31");
    expect(html).toContain("--feedback-level:0.48");
  });

  it("projects the canonical scene read order and apparatus coordinates", () => {
    const html = renderScene();
    expect(html).toContain(
      `data-scene-read-order="${GENERATED_SCENE_SPEC.readOrder.join(">").replaceAll("&", "&amp;").replaceAll(">", "&gt;")}"`,
    );
    expect(html).toContain(
      `data-conceptual-input-count="${GENERATED_SCENE_SPEC.inputCount}"`,
    );
    expect(html).toContain(
      `data-conceptual-output-count="${GENERATED_SCENE_SPEC.outputCount}"`,
    );
    expect(html).toContain(
      `data-camera-projection="${GENERATED_SCENE_SPEC.camera.projection}"`,
    );
    expect(html).toContain(
      `data-camera-fov="${GENERATED_SCENE_SPEC.camera.fieldOfViewDegrees}"`,
    );
    expect(html).toContain(
      `data-camera-clip="${GENERATED_SCENE_SPEC.camera.near},${GENERATED_SCENE_SPEC.camera.far}"`,
    );
    for (const position of [
      GENERATED_SCENE_SPEC.apparatus.speaker.position,
      GENERATED_SCENE_SPEC.apparatus.plate.position,
      GENERATED_SCENE_SPEC.apparatus.microphone.position,
    ]) {
      expect(html).toContain(
        `data-apparatus-position="${position.join(",")}"`,
      );
    }
    expect(html).toContain(
      `data-signal-direction="${GENERATED_SCENE_SPEC.apparatus.cable.direction}"`,
    );
  });

  it("uses the canonical integer width and measuring label", () => {
    const html = renderScene({
      volume: 7,
      measurementStatus: "measuring",
    });
    const expectedVolume = "7".padStart(
      GENERATED_VOLUME_MAP_SPEC.display.widthDigits,
      "0",
    );
    expect(html).toContain(`<strong>${expectedVolume}</strong>`);
    expect(html).toContain(
      GENERATED_VOLUME_MAP_SPEC.display.measuringLabel,
    );
  });
});
