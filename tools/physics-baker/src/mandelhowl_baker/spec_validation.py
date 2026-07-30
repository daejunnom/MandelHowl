"""Cross-field semantic validation for the canonical plate specification."""

from __future__ import annotations

import math
from typing import Any


def _vector_norm(vector: dict[str, Any]) -> float:
    return math.sqrt(
        float(vector["x"]) ** 2
        + float(vector["y"]) ** 2
        + float(vector["z"]) ** 2
    )


def validate_plate_spec_contract(spec: dict[str, Any]) -> None:
    """Validate relationships JSON Schema cannot express by itself."""

    geometry = spec["geometry"]
    radius = float(geometry["radiusM"])
    hub = float(geometry["hub"]["radiusM"])
    hub_centre = geometry["hub"]["centreM"]
    if not 0.0 < hub < radius:
        raise ValueError("plate and hub radii are inconsistent")
    if any(float(hub_centre[axis]) != 0.0 for axis in ("x", "y", "z")):
        raise ValueError("the clamped hub must be centred on the plate origin")

    bounds = spec["mandelbrotField"]["complexBounds"]
    if not (
        float(bounds["realMin"]) < float(bounds["realMax"])
        and float(bounds["imaginaryMin"]) < float(bounds["imaginaryMax"])
    ):
        raise ValueError("Mandelbrot complex bounds are not ordered")
    manufacturing_filter = spec["mandelbrotField"]["manufacturingFilter"]
    if (
        float(manufacturing_filter["minimumFeatureM"]) <= 0.0
        or float(manufacturing_filter["radiusM"]) <= 0.0
        or float(manufacturing_filter["radiusM"])
        > float(manufacturing_filter["minimumFeatureM"])
    ):
        raise ValueError("manufacturing feature/filter radii are inconsistent")

    thickness = spec["thicknessMapping"]
    limits = spec["manufacturingLimits"]
    minimum_thickness = float(thickness["minimumThicknessM"])
    maximum_thickness = float(thickness["maximumThicknessM"])
    if not 0.0 < minimum_thickness < maximum_thickness:
        raise ValueError("thickness mapping limits are inconsistent")
    if float(limits["minimumConnectedThicknessM"]) > minimum_thickness:
        raise ValueError("connected-thickness limit exceeds mapped minimum thickness")
    mass_minimum, mass_maximum = map(float, limits["totalMassRangeKg"])
    if not 0.0 < mass_minimum < mass_maximum:
        raise ValueError("manufacturing mass range is inconsistent")
    if not 0.0 <= float(limits["centreOfMassOffsetMaximumM"]) < radius:
        raise ValueError("centre-of-mass offset limit is inconsistent")

    for label, vector in (
        ("actuator.direction", spec["actuator"]["direction"]),
        ("virtualMicrophone.aimDirection", spec["virtualMicrophone"]["aimDirection"]),
    ):
        if abs(_vector_norm(vector) - 1.0) > 1e-12:
            raise ValueError(f"{label} must be a unit vector")
    actuator = spec["actuator"]
    actuator_radius = math.hypot(
        float(actuator["positionM"]["x"]), float(actuator["positionM"]["y"])
    )
    footprint = float(actuator["footprintRadiusM"])
    if actuator_radius - footprint <= hub or actuator_radius + footprint >= radius:
        raise ValueError("actuator footprint must lie on the free annular surface")
    microphone = spec["virtualMicrophone"]
    microphone_radius = math.hypot(
        float(microphone["positionM"]["x"]),
        float(microphone["positionM"]["y"]),
    )
    if (
        microphone_radius + float(microphone["apertureRadiusM"]) >= radius
        or float(microphone["positionM"]["z"]) <= float(geometry["frontSurfaceZM"])
        or float(microphone["aimDirection"]["z"]) >= 0.0
    ):
        raise ValueError("virtual microphone placement/aim is inconsistent")

    frequency = spec["frequencyRange"]
    frequency_pair = spec["solverRequest"]["frequencyRangeHz"]
    if list(frequency_pair) != [frequency["minimumHz"], frequency["maximumHz"]]:
        raise ValueError("solver and runtime frequency ranges differ")
    levels = spec["solverRequest"]["meshLevels"]
    names = [level["name"] for level in levels]
    sizes = [float(level["targetElementSizeM"]) for level in levels]
    radial_elements = [
        int(level["analysisFiniteStrip"]["radialElementCount"])
        for level in levels
    ]
    maximum_fourier_orders = [
        int(level["analysisFiniteStrip"]["maximumFourierOrder"])
        for level in levels
    ]
    angular_samples = [
        int(level["analysisFiniteStrip"]["angularQuadratureSamples"])
        for level in levels
    ]
    if names != ["coarse", "medium", "fine"] or any(
        left <= right for left, right in zip(sizes, sizes[1:])
    ):
        raise ValueError("v1 mesh levels must be coarse, medium, fine in refinement order")
    if (
        any(
            left >= right
            for left, right in zip(radial_elements, radial_elements[1:])
        )
        or any(
            left >= right
            for left, right in zip(
                maximum_fourier_orders, maximum_fourier_orders[1:]
            )
        )
        or any(
            left >= right
            for left, right in zip(angular_samples, angular_samples[1:])
        )
        or any(
            samples < 4 * maximum_order + 1
            for samples, maximum_order in zip(
                angular_samples, maximum_fourier_orders
            )
        )
        or any(
            2 * element_count * (1 + 2 * maximum_order)
            < int(spec["solverRequest"]["requestedModeCount"])
            for element_count, maximum_order in zip(
                radial_elements, maximum_fourier_orders
            )
        )
    ):
        raise ValueError(
            "finite-strip element, Fourier, and quadrature levels must "
            "refine with enough degrees of freedom"
        )
    quality = spec["solverRequest"]["meshQuality"]
    minimum_edge = float(quality["minimumEdgeM"])
    minimum_area = float(quality["minimumSignedAreaM2"])
    maximum_aspect = float(quality["maximumAspectRatio"])
    if (
        not all(
            math.isfinite(value)
            for value in (minimum_edge, minimum_area, maximum_aspect)
        )
        or minimum_edge <= 0.0
        or minimum_area <= 0.0
        or maximum_aspect < 1.0
        or quality["requiredConnectedComponentCount"] != 1
        or quality["maximumInvertedTriangleCount"] != 0
    ):
        raise ValueError("mesh quality thresholds are invalid")
    if minimum_edge >= sizes[-1]:
        raise ValueError(
            "minimum mesh edge threshold must remain below the fine target size"
        )

    field_resolution = spec["mandelbrotField"]["sampleResolution"]
    texture_resolution = spec["textureRequest"]
    if field_resolution["widthPx"] != field_resolution["heightPx"]:
        raise ValueError("the v1 baker requires a square Mandelbrot sample field")
    if texture_resolution["widthPx"] != texture_resolution["heightPx"]:
        raise ValueError("the v1 baker requires square texture atlases")
    if set(texture_resolution["channels"]) != {
        "signed-displacement-r8",
        "normal-rg8",
        "nodal-mask-r8",
        "sand-density-r8",
    }:
        raise ValueError("the v1 runtime requires all four scientific texture atlases")
