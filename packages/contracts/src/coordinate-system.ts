export interface Vector3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export type Point3Metres = Vector3;

/**
 * The canonical plate-local frame is right-handed:
 * +x follows the Mandelbrot real axis, +y follows its imaginary axis, and +z
 * points from the flat sand-facing front surface toward the virtual microphone.
 * The origin is the centre of that front surface.
 */
export interface PlateCoordinateSystem {
  readonly frame: "plate-local";
  readonly handedness: "right";
  readonly origin: "plate-centre-front-surface";
  readonly xAxis: "mandelbrot-real-positive";
  readonly yAxis: "mandelbrot-imaginary-positive";
  readonly zAxis: "front-normal";
}

export interface SiUnitDeclaration {
  readonly system: "SI";
  readonly length: "m";
  readonly mass: "kg";
  readonly time: "s";
  readonly frequency: "Hz";
  readonly angle: "rad";
  readonly pressure: "Pa";
  readonly density: "kg/m^3";
}
