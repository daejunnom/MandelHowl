import type { DialConfig } from "./dial-state";
import type { DialPoint } from "./radial-dead-zone";

export type DialKeyboardKey =
  | "ArrowLeft"
  | "ArrowRight"
  | "ArrowDown"
  | "ArrowUp"
  | "PageDown"
  | "PageUp"
  | "Home"
  | "End";

export type DialCommand =
  | {
      readonly type: "pointer-start" | "pointer-move";
      readonly point: DialPoint;
      readonly center: DialPoint;
      readonly timestampMs: number;
      readonly deadZoneRadius?: number;
    }
  | {
      readonly type: "pointer-end";
      readonly timestampMs: number;
    }
  | {
      readonly type: "keyboard";
      readonly key: DialKeyboardKey;
      readonly timestampMs?: number;
    }
  | {
      readonly type: "wheel";
      readonly deltaY: number;
      readonly timestampMs?: number;
    }
  | {
      readonly type: "nudge";
      readonly deltaRadians: number;
      readonly timestampMs?: number;
    }
  | {
      readonly type: "set-frequency";
      readonly frequencyHz: number;
      readonly timestampMs?: number;
    }
  | {
      readonly type: "advance";
      readonly deltaSeconds: number;
    }
  | {
      readonly type: "reset";
      readonly frequencyHz?: number;
      readonly config?: Partial<Omit<DialConfig, "version">>;
    };
