import { describe, expect, it } from "vitest";
import {
  canStartDialPointerGesture,
  createDialKeyboardCommand,
  createDialPointerCommand,
  createDialWheelCommand,
  createUiInputEventIdScope,
  isDialKeyboardKey,
} from "../../packages/browser-runtime/src";
import { GENERATED_DIAL_SPEC } from "../../packages/contracts/src";

describe("framework-neutral dial input contract", () => {
  it("keeps one pointer as the gesture owner until it is released", () => {
    expect(canStartDialPointerGesture(null)).toBe(true);
    expect(canStartDialPointerGesture(41)).toBe(false);
  });

  it("maps identical React and Svelte pointer geometry to one command", () => {
    const nativeInput = {
      type: "pointer-start" as const,
      clientX: 320,
      clientY: 180,
      timestampMs: 42,
      bounds: { left: 100, top: 50, width: 300, height: 260 },
      radialDeadZone: 0.18,
    };

    const reactCommand = createDialPointerCommand(nativeInput);
    const svelteCommand = createDialPointerCommand({ ...nativeInput });

    expect(svelteCommand).toEqual(reactCommand);
    expect(reactCommand).toEqual({
      type: "pointer-start",
      point: { x: 320, y: 180 },
      center: { x: 250, y: 180 },
      deadZoneRadius: 46.8,
      timestampMs: 42,
    });
  });

  it("uses the same accepted keyboard language and wheel mapping", () => {
    expect(isDialKeyboardKey("PageUp")).toBe(true);
    expect(isDialKeyboardKey("Enter")).toBe(false);
    expect(createDialKeyboardCommand("PageUp", 12)).toEqual({
      type: "keyboard",
      key: "PageUp",
      timestampMs: 12,
    });
    expect(createDialWheelCommand(-120, 13)).toEqual({
      type: "wheel",
      deltaY: -120,
      timestampMs: 13,
    });
  });

  it("suppresses Shift+Arrow instead of exposing a fine-control shortcut", () => {
    expect(GENERATED_DIAL_SPEC.keyboard.arrowStepRad).toBe(0.035);
    expect(createDialKeyboardCommand("ArrowRight", 12)).toEqual({
      type: "keyboard",
      key: "ArrowRight",
      timestampMs: 12,
    });
    for (const key of [
      "ArrowLeft",
      "ArrowRight",
      "ArrowUp",
      "ArrowDown",
    ] as const) {
      expect(createDialKeyboardCommand(key, 12, true)).toBeNull();
    }
    expect(createDialKeyboardCommand("PageUp", 12, true)).toEqual({
      type: "keyboard",
      key: "PageUp",
      timestampMs: 12,
    });
  });

  it("keeps native event identity stable across UI generations", () => {
    const command = createDialKeyboardCommand("ArrowUp", 91.25);
    const svelteIds = createUiInputEventIdScope("svelte5:1");
    const reactIds = createUiInputEventIdScope("react:2");

    expect(svelteIds.forCommand(command)).toBe(
      "keyboard:91.25:ArrowUp",
    );
    expect(reactIds.forCommand(command)).toBe(
      "keyboard:91.25:ArrowUp",
    );
    expect(svelteIds.related()).toBe(
      "keyboard:91.25:ArrowUp",
    );
    expect(reactIds.related()).toBe(
      "keyboard:91.25:ArrowUp",
    );
  });

  it("does not collapse distinct low-resolution events with one timestamp", () => {
    const ids = createUiInputEventIdScope("svelte5:1");
    const left = ids.forCommand(
      createDialKeyboardCommand("ArrowLeft", 100),
    );
    const right = ids.forCommand(
      createDialKeyboardCommand("ArrowRight", 100),
    );
    expect(left).not.toBe(right);

    const firstPointer = ids.forCommand(
      createDialPointerCommand({
        type: "pointer-move",
        clientX: 10,
        clientY: 20,
        timestampMs: 100,
        bounds: { left: 0, top: 0, width: 100, height: 100 },
        radialDeadZone: 0.2,
      }),
    );
    const secondPointer = ids.forCommand(
      createDialPointerCommand({
        type: "pointer-move",
        clientX: 11,
        clientY: 20,
        timestampMs: 100,
        bounds: { left: 0, top: 0, width: 100, height: 100 },
        radialDeadZone: 0.2,
      }),
    );
    expect(firstPointer).not.toBe(secondPointer);
  });
});
