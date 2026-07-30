import type {
  DialCommand,
  DialKeyboardKey,
} from "../../dial-engine/src";

export const DIAL_KEYBOARD_KEYS = Object.freeze([
  "ArrowLeft",
  "ArrowRight",
  "ArrowDown",
  "ArrowUp",
  "PageDown",
  "PageUp",
  "Home",
  "End",
] as const satisfies readonly DialKeyboardKey[]);

const DIAL_KEYBOARD_KEY_SET = new Set<string>(DIAL_KEYBOARD_KEYS);

export function isDialKeyboardKey(key: string): key is DialKeyboardKey {
  return DIAL_KEYBOARD_KEY_SET.has(key);
}

/**
 * One physical gesture owns the dial until its matching end, cancel, or lost
 * capture event. Secondary touch/pen contacts must never replace that owner.
 */
export function canStartDialPointerGesture(
  activePointerId: number | null,
): boolean {
  return activePointerId === null;
}

export interface DialPointerCommandInput {
  readonly type: "pointer-start" | "pointer-move";
  readonly clientX: number;
  readonly clientY: number;
  readonly timestampMs: number;
  readonly bounds: {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  };
  readonly radialDeadZone: number;
}

/**
 * Canonical native-DOM to DialCommand mapping shared by every UI version.
 * Keeping geometry here prevents the React and Svelte shells from becoming
 * subtly different experiment inputs.
 */
export function createDialPointerCommand(
  input: DialPointerCommandInput,
): DialCommand {
  const { bounds } = input;
  return Object.freeze({
    type: input.type,
    point: Object.freeze({ x: input.clientX, y: input.clientY }),
    center: Object.freeze({
      x: bounds.left + bounds.width / 2,
      y: bounds.top + bounds.height / 2,
    }),
    deadZoneRadius:
      Math.min(bounds.width, bounds.height) * input.radialDeadZone,
    timestampMs: input.timestampMs,
  });
}

export function createDialKeyboardCommand(
  key: DialKeyboardKey,
  timestampMs: number,
): DialCommand;
export function createDialKeyboardCommand(
  key: DialKeyboardKey,
  timestampMs: number,
  shiftKey: boolean,
): DialCommand | null;
export function createDialKeyboardCommand(
  key: DialKeyboardKey,
  timestampMs: number,
  shiftKey = false,
): DialCommand | null {
  if (shiftKey && key.startsWith("Arrow")) {
    return null;
  }
  return Object.freeze({
    type: "keyboard",
    key,
    timestampMs,
  });
}

export function createDialWheelCommand(
  deltaY: number,
  timestampMs: number,
): DialCommand {
  return Object.freeze({ type: "wheel", deltaY, timestampMs });
}

export interface UiInputEventIdScope {
  forCommand(command: DialCommand): string;
  related(): string;
}

function numberIdentity(value: number | undefined): string {
  return value === undefined ? "" : String(value);
}

function commandIdentity(command: DialCommand): string {
  switch (command.type) {
    case "pointer-start":
    case "pointer-move":
      return [
        numberIdentity(command.point.x),
        numberIdentity(command.point.y),
        numberIdentity(command.center.x),
        numberIdentity(command.center.y),
        numberIdentity(command.deadZoneRadius),
      ].join(",");
    case "keyboard":
      return command.key;
    case "wheel":
      return numberIdentity(command.deltaY);
    case "nudge":
      return numberIdentity(command.deltaRadians);
    case "set-frequency":
      return numberIdentity(command.frequencyCentiHz);
    case "pointer-end":
    case "pointer-cancel":
      return "";
    case "advance":
      return numberIdentity(command.deltaSeconds);
    case "reset":
      return numberIdentity(command.frequencyCentiHz);
  }
}

/**
 * Stable event identity shared by React and Svelte adapters.
 *
 * Timestamped native events keep the same ID across a generation transition,
 * allowing the supervisor to reject a queued replay from a failed view. The
 * bounded fallback is used only for synthetic commands without timestamps.
 */
export function createUiInputEventIdScope(
  fallbackNamespace: string,
): UiInputEventIdScope {
  let fallbackSequence = 0;
  let currentInputEventId: string | null = null;
  const fallback = () => `${fallbackNamespace}:${++fallbackSequence}`;
  return Object.freeze({
    forCommand(command: DialCommand) {
      const timestampMs =
        "timestampMs" in command ? command.timestampMs : undefined;
      const inputEventId =
        typeof timestampMs === "number" && Number.isFinite(timestampMs)
          ? `${command.type}:${timestampMs}:${commandIdentity(command)}`
          : fallback();
      currentInputEventId = inputEventId;
      queueMicrotask(() => {
        if (currentInputEventId === inputEventId) {
          currentInputEventId = null;
        }
      });
      return inputEventId;
    },
    related() {
      return currentInputEventId ?? fallback();
    },
  });
}
