export interface PlateRenderSnapshot {
  activeMode: number;
  feedbackEnvelope: number;
  frequency: number;
  regime: "decaying" | "critical" | "growing" | "saturated";
  simulationTime: number;
  /** Geometry supplied by the canonical modal dataset, never inferred here. */
  radialOrder?: number;
  angularOrder?: number;
  modePhaseRadians?: number;
}

export interface PlatePainterOptions {
  reducedMotion?: boolean;
}

const TAU = Math.PI * 2;

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    return minimum;
  }

  return Math.min(maximum, Math.max(minimum, value));
}

function hash01(index: number, salt: number): number {
  const value = Math.sin(index * 127.1 + salt * 311.7) * 43_758.545_312_3;
  return value - Math.floor(value);
}

function modeShape(
  radius: number,
  angle: number,
  radialOrder: number,
  angularOrder: number,
  phase: number,
): number {
  const radial = Math.sin((radialOrder + 0.45) * Math.PI * radius + phase);
  const angular =
    angularOrder === 0
      ? 1
      : Math.cos(angularOrder * angle + phase * 0.58);

  return radial * angular;
}

function fitCanvas(canvas: HTMLCanvasElement): {
  context: CanvasRenderingContext2D;
  width: number;
  height: number;
} | null {
  const context = canvas.getContext("2d");
  if (!context) {
    return null;
  }

  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { context, width: rect.width, height: rect.height };
}

/**
 * Draws a deterministic, mode-parameterized prototype plate. The geometry is
 * intentionally supplied by a mode record rather than generated randomly so
 * that an offline thin-plate texture atlas can replace this painter behind the
 * same
 * snapshot boundary.
 */
export function paintPrototypePlate(
  canvas: HTMLCanvasElement,
  snapshot: PlateRenderSnapshot,
  options: PlatePainterOptions = {},
): void {
  const fitted = fitCanvas(canvas);
  if (!fitted) {
    return;
  }

  const { context, width, height } = fitted;
  const envelope = clamp(snapshot.feedbackEnvelope, 0, 1);
  const size = Math.min(width, height) * 0.86;
  const plateRadius = size * 0.5;
  const centerX = width * 0.5;
  const centerY = height * 0.5;
  const modeIndex = Math.max(0, Math.floor(snapshot.activeMode));
  const radialOrder = Math.max(1, Math.floor(snapshot.radialOrder ?? 3));
  const angularOrder = Math.max(0, Math.floor(snapshot.angularOrder ?? 4));
  const phase = Number.isFinite(snapshot.modePhaseRadians)
    ? (snapshot.modePhaseRadians ?? 0)
    : 0;
  const motionScale = options.reducedMotion ? 0.18 : 1;
  const pulse =
    Math.sin(snapshot.simulationTime * Math.min(snapshot.frequency, 220) * 0.035) *
    envelope *
    motionScale;

  context.clearRect(0, 0, width, height);

  context.save();
  context.translate(centerX, centerY + pulse * 1.8);

  const shadow = context.createRadialGradient(
    plateRadius * 0.05,
    plateRadius * 0.1,
    plateRadius * 0.1,
    0,
    0,
    plateRadius * 1.18,
  );
  shadow.addColorStop(0, "rgba(0, 0, 0, 0)");
  shadow.addColorStop(0.78, "rgba(0, 0, 0, 0.08)");
  shadow.addColorStop(1, "rgba(0, 0, 0, 0.68)");
  context.fillStyle = shadow;
  context.beginPath();
  context.arc(0, plateRadius * 0.055, plateRadius * 1.08, 0, TAU);
  context.fill();

  const plateGradient = context.createRadialGradient(
    -plateRadius * 0.28,
    -plateRadius * 0.34,
    plateRadius * 0.02,
    0,
    0,
    plateRadius,
  );
  plateGradient.addColorStop(0, "#f4f0df");
  plateGradient.addColorStop(0.28, "#b9b7aa");
  plateGradient.addColorStop(0.68, "#686d69");
  plateGradient.addColorStop(0.94, "#242b29");
  plateGradient.addColorStop(1, "#0c1110");

  context.beginPath();
  context.arc(0, 0, plateRadius, 0, TAU);
  context.fillStyle = plateGradient;
  context.fill();
  context.lineWidth = Math.max(1.5, plateRadius * 0.012);
  context.strokeStyle = "rgba(232, 226, 197, 0.52)";
  context.stroke();
  context.clip();

  const glowColour =
    snapshot.regime === "saturated"
      ? "rgba(255, 87, 53, 0.2)"
      : snapshot.regime === "critical"
        ? "rgba(238, 207, 99, 0.17)"
        : "rgba(117, 211, 192, 0.11)";
  const glow = context.createRadialGradient(0, 0, 0, 0, 0, plateRadius);
  glow.addColorStop(0, glowColour);
  glow.addColorStop(1, "rgba(0, 0, 0, 0)");
  context.fillStyle = glow;
  context.fillRect(-plateRadius, -plateRadius, plateRadius * 2, plateRadius * 2);

  context.globalCompositeOperation = "screen";
  context.lineWidth = Math.max(0.75, plateRadius * 0.005);
  for (let ring = 1; ring <= 18; ring += 1) {
    context.beginPath();
    context.arc(0, 0, (plateRadius * ring) / 18, 0, TAU);
    context.strokeStyle = `rgba(244, 239, 213, ${0.018 + ring * 0.0015})`;
    context.stroke();
  }

  context.globalCompositeOperation = "source-over";
  const particleCount = Math.round(520 + envelope * 620);
  const nodeThreshold = 0.14 + envelope * 0.08;
  for (let index = 0; index < particleCount; index += 1) {
    const candidateRadius = Math.sqrt(hash01(index, modeIndex + 0.17)) * 0.94;
    const candidateAngle = hash01(index, modeIndex + 2.43) * TAU;
    const shapeValue = modeShape(
      candidateRadius,
      candidateAngle,
      radialOrder,
      angularOrder,
      phase,
    );
    const attraction = 1 - Math.min(1, Math.abs(shapeValue) / nodeThreshold);
    const looseGrain = hash01(index, modeIndex + 9.1) > envelope * 0.88;

    if (attraction <= 0.08 && !looseGrain) {
      continue;
    }

    const jitter = (hash01(index, modeIndex + 4.9) - 0.5) * 0.018;
    const radius = clamp(candidateRadius + jitter, 0.04, 0.95) * plateRadius;
    const x = Math.cos(candidateAngle) * radius;
    const y = Math.sin(candidateAngle) * radius;
    const grainSize = 0.55 + hash01(index, modeIndex + 7.8) * 1.15;
    const alpha = looseGrain
      ? 0.16 + envelope * 0.14
      : 0.28 + attraction * 0.58;

    context.fillStyle = `rgba(238, 216, 157, ${alpha})`;
    context.beginPath();
    context.arc(x, y, grainSize, 0, TAU);
    context.fill();
  }

  context.restore();

  context.save();
  context.translate(centerX, centerY + pulse * 1.8);
  const hubGradient = context.createRadialGradient(
    -plateRadius * 0.03,
    -plateRadius * 0.04,
    0,
    0,
    0,
    plateRadius * 0.13,
  );
  hubGradient.addColorStop(0, "#eee9d6");
  hubGradient.addColorStop(0.5, "#777c76");
  hubGradient.addColorStop(1, "#171d1b");
  context.fillStyle = hubGradient;
  context.beginPath();
  context.arc(0, 0, plateRadius * 0.115, 0, TAU);
  context.fill();
  context.strokeStyle = "rgba(12, 17, 16, 0.72)";
  context.lineWidth = 2;
  context.stroke();
  context.restore();
}
