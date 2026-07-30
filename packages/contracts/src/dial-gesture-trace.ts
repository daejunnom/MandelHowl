/**
 * Serializable, clock-independent dial history. Pointer coordinates use the
 * same coordinate space for point and centre; timestamps are supplied by the
 * replay clock and are therefore intentionally absent from commands.
 */
export type DialTraceCommand =
  | {
      readonly type: "pointer-start" | "pointer-move";
      readonly point: { readonly x: number; readonly y: number };
      readonly center: { readonly x: number; readonly y: number };
      readonly deadZoneRadius?: number;
    }
  | { readonly type: "pointer-end" | "pointer-cancel" }
  | {
      readonly type: "keyboard";
      readonly key:
        | "ArrowLeft"
        | "ArrowRight"
        | "ArrowDown"
        | "ArrowUp"
        | "PageDown"
        | "PageUp"
        | "Home"
        | "End";
    }
  | { readonly type: "wheel"; readonly deltaY: number }
  | { readonly type: "nudge"; readonly deltaRadians: number }
  | {
      readonly type: "set-frequency";
      readonly frequencyCentiHz: number;
    };

export interface DialTraceEvent {
  readonly sequence: number;
  readonly atSeconds: number;
  readonly command: DialTraceCommand;
}
export interface DialGestureTrace {
  readonly schemaVersion: "mandelhowl.dial-gesture-trace.v2";
  readonly traceId: string;
  readonly initialFrequencyCentiHz: number;
  readonly durationSeconds: number;
  readonly events: readonly DialTraceEvent[];
}
