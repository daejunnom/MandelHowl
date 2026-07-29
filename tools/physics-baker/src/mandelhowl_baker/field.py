"""Finite-resolution Mandelbrot thickness-field generation."""

from __future__ import annotations

import math
import struct
import sys
from collections import deque
from dataclasses import dataclass
from typing import Any

from .algorithm import (
    CONJUGATE_TOLERANCE,
    FIELD_BEVEL_PASSES,
    FIELD_BOX_PASSES,
    FIELD_ESCAPE_RADIUS,
    FIELD_MINIMUM_RESOLUTION,
)


@dataclass(frozen=True)
class MaterialField:
    size: int
    radius_m: float
    values: tuple[float, ...]
    thickness_m: tuple[float, ...]
    inside_plate: tuple[bool, ...]
    statistics: dict[str, float | int | bool]

    def at(self, x_m: float, y_m: float, *, thickness: bool = False) -> float:
        values = self.thickness_m if thickness else self.values
        u = (x_m / (2.0 * self.radius_m) + 0.5) * (self.size - 1)
        v = (y_m / (2.0 * self.radius_m) + 0.5) * (self.size - 1)
        u = max(0.0, min(self.size - 1.0, u))
        v = max(0.0, min(self.size - 1.0, v))
        x0 = min(self.size - 2, int(math.floor(u)))
        y0 = min(self.size - 2, int(math.floor(v)))
        tx = u - x0
        ty = v - y0
        i00 = y0 * self.size + x0
        a = values[i00] * (1.0 - tx) + values[i00 + 1] * tx
        b = values[i00 + self.size] * (1.0 - tx) + values[i00 + self.size + 1] * tx
        return a * (1.0 - ty) + b * ty

    def to_binary(self) -> bytes:
        header = struct.pack("<8sIIff", b"MHFIELD1", 1, self.size, -self.radius_m, self.radius_m)
        samples = bytes(max(0, min(255, round(value * 255.0))) for value in self.values)
        return header + samples


def mandelbrot_value(real: float, imaginary: float, maximum_iterations: int) -> float:
    zr = 0.0
    zi = 0.0
    escape_iteration = maximum_iterations
    magnitude_squared = 0.0
    for iteration in range(maximum_iterations):
        zr, zi = zr * zr - zi * zi + real, 2.0 * zr * zi + imaginary
        magnitude_squared = zr * zr + zi * zi
        if magnitude_squared > FIELD_ESCAPE_RADIUS * FIELD_ESCAPE_RADIUS:
            escape_iteration = iteration + 1
            break
    if escape_iteration == maximum_iterations:
        return 1.0
    magnitude = math.sqrt(magnitude_squared)
    smooth_iteration = escape_iteration + 1.0 - math.log(math.log(magnitude)) / math.log(2.0)
    return max(0.0, min(1.0, smooth_iteration / maximum_iterations))


def _window_extreme(values: list[float], size: int, radius: int, maximum: bool) -> list[float]:
    def sliding(samples: list[float]) -> list[float]:
        result = [0.0] * len(samples)
        candidates: deque[int] = deque()
        added = -1
        for index in range(len(samples)):
            wanted = min(len(samples) - 1, index + radius)
            while added < wanted:
                added += 1
                while candidates and (
                    samples[candidates[-1]] <= samples[added]
                    if maximum
                    else samples[candidates[-1]] >= samples[added]
                ):
                    candidates.pop()
                candidates.append(added)
            minimum_index = index - radius
            while candidates and candidates[0] < minimum_index:
                candidates.popleft()
            result[index] = samples[candidates[0]]
        return result

    horizontal = [0.0] * len(values)
    for y in range(size):
        row = y * size
        horizontal[row : row + size] = sliding(values[row : row + size])
    result = [0.0] * len(values)
    for x in range(size):
        column = sliding([horizontal[y * size + x] for y in range(size)])
        for y, sample in enumerate(column):
            result[y * size + x] = sample
    return result


def _box_blur(values: list[float], size: int, radius: int) -> list[float]:
    horizontal = [0.0] * len(values)
    for y in range(size):
        prefix = [0.0]
        row = y * size
        for x in range(size):
            prefix.append(prefix[-1] + values[row + x])
        for x in range(size):
            lo = max(0, x - radius)
            hi = min(size - 1, x + radius)
            horizontal[row + x] = (prefix[hi + 1] - prefix[lo]) / (hi - lo + 1)
    result = [0.0] * len(values)
    for x in range(size):
        prefix = [0.0]
        for y in range(size):
            prefix.append(prefix[-1] + horizontal[y * size + x])
        for y in range(size):
            lo = max(0, y - radius)
            hi = min(size - 1, y + radius)
            result[y * size + x] = (prefix[hi + 1] - prefix[lo]) / (hi - lo + 1)
    return result


def _smoothstep(value: float) -> float:
    value = max(0.0, min(1.0, value))
    return value * value * (3.0 - 2.0 * value)


def generate_material_field(spec: dict[str, Any], size: int = 96) -> MaterialField:
    if size < FIELD_MINIMUM_RESOLUTION:
        raise ValueError(
            f"analysis field resolution must be at least {FIELD_MINIMUM_RESOLUTION}"
        )
    radius = float(spec["geometry"]["radiusM"])
    field_spec = spec["mandelbrotField"]
    requested_escape_radius = float(field_spec["escapeRadius"])
    if abs(requested_escape_radius - FIELD_ESCAPE_RADIUS) > sys.float_info.epsilon:
        raise ValueError(
            "algorithm revision requires escape radius "
            f"{FIELD_ESCAPE_RADIUS:g}, spec requested {requested_escape_radius:g}"
        )
    bounds = field_spec["complexBounds"]
    maximum_iterations = int(field_spec["maximumIterations"])
    pixel_m = 2.0 * radius / size
    raw: list[float] = [0.0] * (size * size)
    inside_plate: list[bool] = [False] * (size * size)
    conjugate_symmetric = math.isclose(
        float(bounds["imaginaryMin"]),
        -float(bounds["imaginaryMax"]),
        rel_tol=0.0,
        abs_tol=CONJUGATE_TOLERANCE,
    )
    evaluated_rows = (size + 1) // 2 if conjugate_symmetric else size
    for y in range(evaluated_rows):
        y_m = -radius + (y + 0.5) * pixel_m
        imaginary = bounds["imaginaryMin"] + (y_m + radius) / (2.0 * radius) * (
            bounds["imaginaryMax"] - bounds["imaginaryMin"]
        )
        for x in range(size):
            x_m = -radius + (x + 0.5) * pixel_m
            real = bounds["realMin"] + (x_m + radius) / (2.0 * radius) * (
                bounds["realMax"] - bounds["realMin"]
            )
            index = y * size + x
            raw[index] = mandelbrot_value(real, imaginary, maximum_iterations)
            inside_plate[index] = x_m * x_m + y_m * y_m <= radius * radius
            if conjugate_symmetric:
                mirror_y = size - 1 - y
                mirror = mirror_y * size + x
                raw[mirror] = raw[index]
                inside_plate[mirror] = inside_plate[index]

    filter_spec = field_spec["manufacturingFilter"]
    filter_radius = max(1, round(float(filter_spec["radiusM"]) / pixel_m))
    blurred = raw
    for _ in range(FIELD_BOX_PASSES):
        blurred = _box_blur(blurred, size, filter_radius)
    closed = _window_extreme(
        _window_extreme(blurred, size, filter_radius, True),
        size,
        filter_radius,
        False,
    )
    filtered = _window_extreme(
        _window_extreme(closed, size, filter_radius, False),
        size,
        filter_radius,
        True,
    )
    levels = int(filter_spec["quantizationLevels"])
    filtered = [round(value * (levels - 1)) / (levels - 1) for value in filtered]
    # A machined stepped back surface needs finite-width bevels between levels;
    # otherwise an ideal mathematical step has infinite thickness gradient.
    # Two deterministic box passes model that manufacturing transition while
    # retaining the quantized field as its source.
    bevel_passes = FIELD_BEVEL_PASSES
    for _ in range(bevel_passes):
        filtered = _box_blur(filtered, size, filter_radius)

    if conjugate_symmetric:
        # Re-impose symmetry only when the requested complex bounds themselves
        # are conjugate symmetric. Alternate valid bounds must retain their
        # intentionally asymmetric material field.
        for y in range(size // 2):
            mirror_y = size - 1 - y
            for x in range(size):
                index = y * size + x
                mirror = mirror_y * size + x
                average = (filtered[index] + filtered[mirror]) * 0.5
                filtered[index] = average
                filtered[mirror] = average

    mapping = spec["thicknessMapping"]
    minimum = float(mapping["minimumThicknessM"])
    maximum = float(mapping["maximumThicknessM"])
    thickness = [minimum + (maximum - minimum) * _smoothstep(value) for value in filtered]

    density = float(spec["material"]["densityKgPerM3"])
    area = pixel_m * pixel_m
    total_mass = 0.0
    first_x = 0.0
    first_y = 0.0
    for y in range(size):
        y_m = -radius + (y + 0.5) * pixel_m
        for x in range(size):
            index = y * size + x
            if not inside_plate[index]:
                continue
            x_m = -radius + (x + 0.5) * pixel_m
            sample_mass = density * thickness[index] * area
            total_mass += sample_mass
            first_x += sample_mass * x_m
            first_y += sample_mass * y_m
    centre_x = first_x / total_mass
    centre_y = first_y / total_mass
    centre_offset = math.hypot(centre_x, centre_y)

    maximum_gradient = 0.0
    for y in range(1, size - 1):
        for x in range(1, size - 1):
            index = y * size + x
            if not inside_plate[index]:
                continue
            dx = (thickness[index + 1] - thickness[index - 1]) / (2.0 * pixel_m)
            dy = (thickness[index + size] - thickness[index - size]) / (2.0 * pixel_m)
            maximum_gradient = max(maximum_gradient, math.hypot(dx, dy))

    limits = spec["manufacturingLimits"]
    mass_minimum, mass_maximum = map(float, limits["totalMassRangeKg"])
    statistics: dict[str, float | int | bool] = {
        "analysisResolutionPx": size,
        "pixelPitchM": pixel_m,
        "filterRadiusPx": filter_radius,
        "manufacturingBevelPasses": bevel_passes,
        "actualMinimumFeatureM": 2.0 * filter_radius * pixel_m,
        "minimumFeatureMeasurement": (
            "conservative close/open structuring-element diameter on the sampled field"
        ),
        "quantizationLevels": levels,
        "minimumThicknessM": min(thickness[index] for index, flag in enumerate(inside_plate) if flag),
        "maximumThicknessM": max(thickness[index] for index, flag in enumerate(inside_plate) if flag),
        "maximumThicknessGradient": maximum_gradient,
        "totalMassKg": total_mass,
        "centreOfMassXM": centre_x,
        "centreOfMassYM": centre_y,
        "centreOfMassOffsetM": centre_offset,
        "massWithinLimits": mass_minimum <= total_mass <= mass_maximum,
        "centreOfMassWithinLimit": centre_offset
        <= float(limits["centreOfMassOffsetMaximumM"]),
        "gradientWithinLimit": maximum_gradient <= float(limits["maximumThicknessGradient"]),
        "minimumThicknessWithinLimit": min(thickness)
        >= float(limits["minimumConnectedThicknessM"]),
        "minimumFeatureWithinLimit": 2.0 * filter_radius * pixel_m
        >= float(filter_spec["minimumFeatureM"]),
    }
    return MaterialField(
        size=size,
        radius_m=radius,
        values=tuple(filtered),
        thickness_m=tuple(thickness),
        inside_plate=tuple(inside_plate),
        statistics=statistics,
    )
