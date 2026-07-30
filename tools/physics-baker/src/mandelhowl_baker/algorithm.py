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
assembly_policy = ALGORITHM_CONTRACT.get("assembly", {})
handoff_policy = ALGORITHM_CONTRACT.get("handoffConformance", {})
texture_policy = ALGORITHM_CONTRACT.get("texture", {})
response_policy = ALGORITHM_CONTRACT.get("response", {})
material_section_policy = ALGORITHM_CONTRACT.get(
    "materialSectionProfile",
    {},
)
if (
    assembly_policy.get("analysisDiscretization")
    != "c1-cubic-hermite-annular-finite-strip"
    or assembly_policy.get("radialInterpolation") != "cubic-hermite-c1"
    or assembly_policy.get("angularInterpolation")
    != "normalized-real-fourier"
    or assembly_policy.get("radialMesh") != "uniform-annular-strips"
    or assembly_policy.get("radialGaussOrder") != 5
    or assembly_policy.get("angularQuadrature") != "midpoint"
    or assembly_policy.get("quadratureLoopOrder")
    != (
        "element-then-radial-gauss-ascending-then-theta-ascending-"
        "then-active-global-index-ascending"
    )
    or assembly_policy.get("boundaryEnforcement")
    != "eliminate-inner-value-and-radial-slope-dofs"
    or assembly_policy.get("analysisResolutionSource")
    != "plate-spec.solverRequest.meshLevels[*].analysisFiniteStrip"
    or handoff_policy.get("section") != "10.3/B1"
    or handoff_policy.get("executedMethod")
    != "c1-cubic-hermite-annular-finite-strip"
    or handoff_policy.get("thinPlateEigenanalysisSupported") is not True
    or handoff_policy.get("surfaceMeshQualityValidated") is not True
    or handoff_policy.get("finiteElementAssemblyUsed") is not True
    or handoff_policy.get("analysisSurfaceElementMeshCoupledToEigenproblem")
    is not True
    or handoff_policy.get("surfaceTriangleArchiveCoupledToEigenproblem")
    is not False
    or handoff_policy.get("strictLiteralConformance") is not True
    or handoff_policy.get("operationalDisposition")
    != "strict-thin-plate-finite-element-adapter"
    or "deviationCode" in handoff_policy
    or ALGORITHM_CONTRACT.get("runtimeModalOutput", {}).get("rounding")
    != "ties-to-even"
    or ALGORITHM_CONTRACT.get("runtimeModalOutput", {}).get(
        "angularFrequencyDerivation"
    )
    != "quantized-frequency-times-ieee754-tau"
    or ALGORITHM_CONTRACT.get("runtimeModalOutput", {}).get("negativeZero")
    != "canonicalize-to-positive-zero"
    or ALGORITHM_CONTRACT.get("runtimeModalOutput", {}).get(
        "frequencyQuantumHz"
    )
    != 2.0**-20
    or ALGORITHM_CONTRACT.get("runtimeModalOutput", {}).get("couplingQuantum")
    != 2.0**-27
    or response_policy.get("spacing") != "logarithmic"
    or texture_policy.get("container") != "KTX2"
    or texture_policy.get("supercompressionScheme") != 3
    or texture_policy.get("layersPerShard") != 4
    or texture_policy.get("shardOrdering")
    != "kind-then-global-texture-layer-ascending"
    or texture_policy.get("shardPathPattern")
    != "textures/{kind}-{firstLayer:02d}-{lastLayer:02d}.ktx2"
    or texture_policy.get("emissiveBasisSource") != "nodal-mask"
    or texture_policy.get("emissiveBasisAliasPolicy")
    != "byte-identical-basis-reuse"
    or material_section_policy.get("sampleCount") != 64
    or material_section_policy.get("axis") != "x-at-y-zero"
    or material_section_policy.get("samplePositionConvention")
    != "uniform-cell-centres"
    or material_section_policy.get("resampling")
    != "bilinear-binary64-thickness"
):
    raise RuntimeError("incompatible MandelHowl baker asset/derivation policy")

ALGORITHM_REVISION = str(ALGORITHM_CONTRACT["algorithmRevision"])
ALGORITHM_CONTRACT_SHA256 = hashlib.sha256(ALGORITHM_CONTRACT_BYTES).hexdigest()
HANDOFF_CONFORMANCE: dict[str, Any] = dict(handoff_policy)

field = ALGORITHM_CONTRACT["field"]
FIELD_MINIMUM_RESOLUTION = int(field["minimumResolutionPx"])
FIELD_ESCAPE_RADIUS = float(field["escapeRadius"])
FIELD_BOX_PASSES = int(field["gaussianApproximationBoxPasses"])
FIELD_BEVEL_PASSES = int(field["manufacturingBevelBoxPasses"])
CONJUGATE_TOLERANCE = float(field["conjugateSymmetryTolerance"])

RADIAL_GAUSS_NODES = tuple(
    float(value) for value in assembly_policy["radialGaussNodes"]
)
RADIAL_GAUSS_WEIGHTS = tuple(
    float(value) for value in assembly_policy["radialGaussWeights"]
)
if (
    len(RADIAL_GAUSS_NODES) != 5
    or len(RADIAL_GAUSS_WEIGHTS) != 5
    or any(
        left >= right
        for left, right in zip(RADIAL_GAUSS_NODES, RADIAL_GAUSS_NODES[1:])
    )
    or any(weight <= 0.0 for weight in RADIAL_GAUSS_WEIGHTS)
    or abs(sum(RADIAL_GAUSS_WEIGHTS) - 2.0) > 1e-15
):
    raise RuntimeError("incompatible finite-strip radial Gauss rule")
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

runtime_modal_output = ALGORITHM_CONTRACT["runtimeModalOutput"]
RUNTIME_FREQUENCY_QUANTUM_HZ = float(
    runtime_modal_output["frequencyQuantumHz"]
)
RUNTIME_COUPLING_QUANTUM = float(runtime_modal_output["couplingQuantum"])

texture = ALGORITHM_CONTRACT["texture"]
TEXTURE_LAYERS_PER_SHARD = int(texture["layersPerShard"])
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

MATERIAL_SECTION_SAMPLE_COUNT = int(
    material_section_policy["sampleCount"]
)
MATERIAL_SECTION_AXIS = str(material_section_policy["axis"])
MATERIAL_SECTION_POSITION_CONVENTION = str(
    material_section_policy["samplePositionConvention"]
)
MATERIAL_SECTION_RESAMPLING = str(
    material_section_policy["resampling"]
)

coverage = ALGORITHM_CONTRACT["foundationCoverage"]
COVERAGE_CAPTURE_RATE = float(coverage["captureRate"])
COVERAGE_MAXIMUM_FRACTION = float(coverage["maximumFraction"])
COVERAGE_MINIMUM_LOG_ARGUMENT = float(coverage["minimumLogArgument"])
COVERAGE_BASE_DETUNE = float(coverage["baseDetuneRatio"])
COVERAGE_DETUNE_STEP = float(coverage["detuneStep"])
COVERAGE_DETUNE_CYCLE = int(coverage["detuneCycle"])
