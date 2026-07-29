import { describe, expect, it } from "vitest";
import {
  createDialKeyboardCommand,
  createDialPointerCommand,
  createDialWheelCommand,
  createUiInputEventIdScope,
  isDialKeyboardKey,
} from "../../packages/browser-runtime/src";

describe("framework-neutral dial input contract", () => {
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

  it("keeps native event identity stable across UI generations", () => {
    const command = createDialKeyboardCommand("ArrowUp", 91.25);
    const svelteIds = createUiInputEventIdScope("svelte5:1");
    const reactIds = createUiInputEventIdScope("react:2");

    expect(svelteIds.forCommand(command)).toBe("keyboard:91.25");
    expect(reactIds.forCommand(command)).toBe("keyboard:91.25");
    expect(svelteIds.related()).toBe("keyboard:91.25");
    expect(reactIds.related()).toBe("keyboard:91.25");
  });
});
