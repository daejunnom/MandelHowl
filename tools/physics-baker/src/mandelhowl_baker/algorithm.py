"""Shared, versioned scientific algorithm contract.

The Python and Rust bakers load the same repository-owned JSON document.  This
module deliberately exposes immutable scalar names so scientific source does
not grow a second set of unversioned magic numbers.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any


ALGORITHM_CONTRACT_PATH = (
    Path(__file__).resolve().parents[4]
    / "specs"
    / "physics"
    / "baker-algorithm.v1.json"
)
ALGORITHM_CONTRACT_BYTES = ALGORITHM_CONTRACT_PATH.read_bytes()
ALGORITHM_CONTRACT: dict[str, Any] = json.loads(
    ALGORITHM_CONTRACT_BYTES.decode("utf-8")
)

if ALGORITHM_CONTRACT.get("schemaVersion") != "mandelhowl.baker-algorithm.v1":
    raise RuntimeError("unsupported MandelHowl baker algorithm contract")
numeric_policy = ALGORITHM_CONTRACT.get("numericPolicy", {})
if (
    numeric_policy.get("floatPrecision") != "binary64"
    or numeric_policy.get("fastMath") is not False
    or numeric_policy.get("summationOrder") != "source-loop-order"
    or numeric_policy.get("quantizationRounding") != "ties-to-even"
    or numeric_policy.get("randomSource") != "forbidden"
):
    raise RuntimeError("incompatible MandelHowl baker numeric policy")

ALGORITHM_REVISION = str(ALGORITHM_CONTRACT["algorithmRevision"])
ALGORITHM_CONTRACT_SHA256 = hashlib.sha256(ALGORITHM_CONTRACT_BYTES).hexdigest()

field = ALGORITHM_CONTRACT["field"]
FIELD_MINIMUM_RESOLUTION = int(field["minimumResolutionPx"])
FIELD_ESCAPE_RADIUS = float(field["escapeRadius"])
FIELD_BOX_PASSES = int(field["gaussianApproximationBoxPasses"])
FIELD_BEVEL_PASSES = int(field["manufacturingBevelBoxPasses"])
CONJUGATE_TOLERANCE = float(field["conjugateSymmetryTolerance"])

basis = ALGORITHM_CONTRACT["basis"]
AXISYMMETRIC_RADIAL_ORDERS = int(basis["axisymmetricRadialOrders"])
LOW_ANGULAR_MINIMUM = int(basis["lowAngularOrderMinimum"])
LOW_ANGULAR_MAXIMUM = int(basis["lowAngularOrderMaximum"])
LOW_ANGULAR_RADIAL_ORDERS = int(basis["lowAngularRadialOrders"])
HIGH_ANGULAR_MINIMUM = int(basis["highAngularOrderMinimum"])
HIGH_ANGULAR_MAXIMUM = int(basis["highAngularOrderMaximum"])
HIGH_ANGULAR_RADIAL_ORDERS = int(basis["highAngularRadialOrders"])
HUB_CLAMP_POWER = int(basis["hubClampPower"])

HESSIAN_STEP_RATIO = float(
    ALGORITHM_CONTRACT["assembly"]["finiteDifferenceHessianStepRatio"]
)
JACOBI_RELATIVE_TOLERANCE = float(
    ALGORITHM_CONTRACT["eigensolver"]["relativeTolerance"]
)
JACOBI_MAXIMUM_SWEEPS = int(ALGORITHM_CONTRACT["eigensolver"]["maximumSweeps"])

coupling = ALGORITHM_CONTRACT["coupling"]
PROBE_RING_SAMPLES = int(coupling["probeRingSamples"])
PROBE_RING_RADIUS_RATIO = float(coupling["probeRingRadiusRatio"])
RADIATION_RADIAL_SAMPLES = int(coupling["radiationRadialSamples"])
RADIATION_ANGULAR_SAMPLES = int(coupling["radiationAngularSamples"])
RADIATION_COHERENCE_FLOOR = float(coupling["radiationCoherenceFloor"])
RADIATION_COHERENCE_WEIGHT = float(coupling["radiationCoherenceWeight"])
SIGN_EPSILON = float(coupling["signEpsilon"])
ORDINAL_DAMPING_SLOPE = float(coupling["ordinalDampingSlope"])

response = ALGORITHM_CONTRACT["response"]
RESPONSE_SAMPLE_COUNT = int(response["sampleCount"])
NORMALIZATION_FLOOR = float(response["normalizationFloor"])

texture = ALGORITHM_CONTRACT["texture"]
NODAL_ABSOLUTE_THRESHOLD = float(texture["nodalAbsoluteThreshold"])
SAND_GAUSSIAN_SCALE = float(texture["sandGaussianScale"])
LOW_VELOCITY_THRESHOLD = float(texture["lowVelocityThreshold"])
HIGH_VELOCITY_THRESHOLD = float(texture["highVelocityThreshold"])
NORMAL_VISUAL_SCALE = float(texture["normalVisualScale"])
FINITE_DIFFERENCE_CHECK_ORDINALS = frozenset(
    int(value) for value in texture["finiteDifferenceCheckOrdinals"]
)
CROSS_VALIDATION_TOLERANCE = float(
    texture["maximumCrossValidationRelativeDifference"]
)

coverage = ALGORITHM_CONTRACT["foundationCoverage"]
COVERAGE_CAPTURE_RATE = float(coverage["captureRate"])
COVERAGE_MAXIMUM_FRACTION = float(coverage["maximumFraction"])
COVERAGE_MINIMUM_LOG_ARGUMENT = float(coverage["minimumLogArgument"])
COVERAGE_BASE_DETUNE = float(coverage["baseDetuneRatio"])
COVERAGE_DETUNE_STEP = float(coverage["detuneStep"])
COVERAGE_DETUNE_CYCLE = int(coverage["detuneCycle"])
