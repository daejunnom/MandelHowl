"""Deterministic annular polar mesh construction and quality evidence."""

from __future__ import annotations

import hashlib
import math
import struct
import zlib
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class MeshEvidence:
    level_name: str
    target_element_size_m: float
    radial_divisions: int
    angular_divisions: int
    node_count: int
    triangle_count: int
    minimum_edge_m: float
    minimum_signed_area_m2: float
    maximum_aspect_ratio: float
    inverted_triangle_count: int
    connected_component_count: int
    fingerprint_sha256: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "levelName": self.level_name,
            "targetElementSizeM": self.target_element_size_m,
            "radialDivisions": self.radial_divisions,
            "angularDivisions": self.angular_divisions,
            "nodeCount": self.node_count,
            "triangleCount": self.triangle_count,
            "minimumEdgeM": self.minimum_edge_m,
            "minimumSignedAreaM2": self.minimum_signed_area_m2,
            "maximumAspectRatio": self.maximum_aspect_ratio,
            "invertedTriangleCount": self.inverted_triangle_count,
            "connectedComponentCount": self.connected_component_count,
            "fingerprintSha256": self.fingerprint_sha256,
        }


def _mesh_dimensions(
    radius: float, hub_radius: float, target: float
) -> tuple[int, int]:
    angular = max(16, math.ceil(2.0 * math.pi * radius / target))
    angular_step = 2.0 * math.pi / angular
    radial = max(4, math.ceil(math.log(radius / hub_radius) / angular_step))
    return radial, angular


def build_mesh_evidence(spec: dict[str, Any], level: dict[str, Any]) -> MeshEvidence:
    radius = float(spec["geometry"]["radiusM"])
    hub_radius = float(spec["geometry"]["hub"]["radiusM"])
    target = float(level["targetElementSizeM"])
    radial, angular = _mesh_dimensions(radius, hub_radius, target)
    angular_step = 2.0 * math.pi / angular
    # Logarithmic rings keep radial and circumferential edge lengths comparable
    # from the small hub to the outer rim. Uniform radial rings paired with an
    # outer-rim angular target create aspect ratios near R/r_hub (~10 here).
    nodes: list[tuple[float, float]] = []
    digest = hashlib.sha256()
    for ring in range(radial + 1):
        r = hub_radius * (radius / hub_radius) ** (ring / radial)
        for sector in range(angular):
            theta = 2.0 * math.pi * sector / angular
            point = (r * math.cos(theta), r * math.sin(theta))
            nodes.append(point)
            digest.update(struct.pack("<dd", *point))

    minimum_edge = math.inf
    minimum_area = math.inf
    maximum_aspect = 0.0
    inverted = 0
    triangles = 0

    def evaluate(a: int, b: int, c: int) -> None:
        nonlocal minimum_edge, minimum_area, maximum_aspect, inverted, triangles
        pa, pb, pc = nodes[a], nodes[b], nodes[c]
        signed_double_area = (
            (pb[0] - pa[0]) * (pc[1] - pa[1])
            - (pb[1] - pa[1]) * (pc[0] - pa[0])
        )
        area = 0.5 * signed_double_area
        if area <= 0.0:
            inverted += 1
        lengths = (
            math.dist(pa, pb),
            math.dist(pb, pc),
            math.dist(pc, pa),
        )
        shortest_altitude = 2.0 * abs(area) / max(lengths)
        aspect = max(lengths) / shortest_altitude
        minimum_edge = min(minimum_edge, *lengths)
        minimum_area = min(minimum_area, area)
        maximum_aspect = max(maximum_aspect, aspect)
        triangles += 1
        digest.update(struct.pack("<III", a, b, c))

    for ring in range(radial):
        inner = ring * angular
        outer = (ring + 1) * angular
        for sector in range(angular):
            next_sector = (sector + 1) % angular
            a = inner + sector
            b = outer + sector
            c = outer + next_sector
            d = inner + next_sector
            evaluate(a, b, c)
            evaluate(a, c, d)

    return MeshEvidence(
        level_name=str(level["name"]),
        target_element_size_m=target,
        radial_divisions=radial,
        angular_divisions=angular,
        node_count=len(nodes),
        triangle_count=triangles,
        minimum_edge_m=minimum_edge,
        minimum_signed_area_m2=minimum_area,
        maximum_aspect_ratio=maximum_aspect,
        inverted_triangle_count=inverted,
        connected_component_count=1,
        fingerprint_sha256=digest.hexdigest(),
    )


def build_mesh_archive(spec: dict[str, Any], level: dict[str, Any]) -> bytes:
    """Return a zlib-compressed, indexed float32 triangle mesh.

    The uncompressed stream begins with ``MHMESH01``, version, node count,
    triangle count, and coordinate component count, followed by xyz float32
    nodes and uint32 triangle indices.
    """

    radius = float(spec["geometry"]["radiusM"])
    hub_radius = float(spec["geometry"]["hub"]["radiusM"])
    target = float(level["targetElementSizeM"])
    radial, angular = _mesh_dimensions(radius, hub_radius, target)
    node_count = (radial + 1) * angular
    triangle_count = radial * angular * 2
    raw = bytearray(
        struct.pack("<8sIIII", b"MHMESH01", 1, node_count, triangle_count, 3)
    )
    for ring in range(radial + 1):
        radial_position = hub_radius * (radius / hub_radius) ** (ring / radial)
        for sector in range(angular):
            theta = 2.0 * math.pi * sector / angular
            raw.extend(
                struct.pack(
                    "<fff",
                    radial_position * math.cos(theta),
                    radial_position * math.sin(theta),
                    0.0,
                )
            )
    for ring in range(radial):
        inner = ring * angular
        outer = (ring + 1) * angular
        for sector in range(angular):
            next_sector = (sector + 1) % angular
            a = inner + sector
            b = outer + sector
            c = outer + next_sector
            d = inner + next_sector
            raw.extend(struct.pack("<III", a, b, c))
            raw.extend(struct.pack("<III", a, c, d))
    return zlib.compress(bytes(raw), level=9)
