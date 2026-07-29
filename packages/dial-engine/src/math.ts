export const TAU = Math.PI * 2;

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

export function signWithDeadBand(value: number, epsilon = 1e-9): -1 | 0 | 1 {
  if (value > epsilon) return 1;
  if (value < -epsilon) return -1;
  return 0;
}
