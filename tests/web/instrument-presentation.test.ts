import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  MandelHowlScene,
  type MandelHowlSceneProps,
} from "../../app/mandelhowl-scene";

const noOp = () => undefined;

function renderScene(
  overrides: Partial<MandelHowlSceneProps> = {},
): string {
  return renderToStaticMarkup(
    createElement(MandelHowlScene, {
      frequency: 4_629.35,
      angle: 0,
      volume: 50,
      regime: "critical",
      envelope: 0.48,
      activeMode: 44,
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
    expect(html.match(/class="mh-scope-sample"/g)).toHaveLength(40);
    expect(html).toContain(
      'aria-label="Microphone waveform; RMS 31 percent, peak 50 percent"',
    );
  });

  it("keeps the dial frequency unobstructed by decorative center markup", () => {
    const html = renderScene();

    expect(html).toContain("4.63 kHz");
    expect(html).not.toContain("mh-dial-cap");
  });
});
