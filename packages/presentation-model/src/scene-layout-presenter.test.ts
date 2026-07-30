import { describe, expect, it } from "vitest";
import { CANONICAL_SCENE_LAYOUT } from "./scene-layout-presenter";

describe("canonical scene layout projection", () => {
  it("keeps the speaker, plate, and microphone in source coordinate order", () => {
    expect(CANONICAL_SCENE_LAYOUT.speakerCenterXPercent).toBe(10);
    expect(CANONICAL_SCENE_LAYOUT.plateCenterXPercent).toBeGreaterThan(
      CANONICAL_SCENE_LAYOUT.speakerCenterXPercent,
    );
    expect(CANONICAL_SCENE_LAYOUT.plateCenterXPercent).toBeLessThan(
      CANONICAL_SCENE_LAYOUT.microphoneCenterXPercent,
    );
    expect(CANONICAL_SCENE_LAYOUT.microphoneCenterXPercent).toBe(90);
    expect(CANONICAL_SCENE_LAYOUT.microphoneCenterYPercent).toBeLessThan(
      CANONICAL_SCENE_LAYOUT.plateCenterYPercent,
    );
    expect(CANONICAL_SCENE_LAYOUT.plateCenterYPercent).toBeLessThan(
      CANONICAL_SCENE_LAYOUT.speakerCenterYPercent,
    );
    expect(CANONICAL_SCENE_LAYOUT.microphoneCenterYPercent).toBe(35);
    expect(CANONICAL_SCENE_LAYOUT.speakerCenterYPercent).toBe(65);
  });
});
