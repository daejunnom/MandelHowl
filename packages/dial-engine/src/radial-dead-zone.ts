import { finiteOr } from "./math";

export interface DialPoint {
  readonly x: number;
  readonly y: number;
}

export function radialDistance(
  point: DialPoint,
  center: DialPoint = { x: 0, y: 0 },
): number {
  const dx = finiteOr(point.x, center.x) - finiteOr(center.x, 0);
  const dy = finiteOr(point.y, center.y) - finiteOr(center.y, 0);
  return Math.hypot(dx, dy);
}

export function isOutsideRadialDeadZone(
  point: DialPoint,
  center: DialPoint = { x: 0, y: 0 },
  deadZoneRadius = 0,
): boolean {
  return radialDistance(point, center) >= Math.max(0, finiteOr(deadZoneRadius, 0));
}

export function pointerAngleRadians(
  point: DialPoint,
  center: DialPoint = { x: 0, y: 0 },
): number {
  const dx = finiteOr(point.x, center.x) - finiteOr(center.x, 0);
  const dy = finiteOr(point.y, center.y) - finiteOr(center.y, 0);
  return Math.atan2(dy, dx);
}
