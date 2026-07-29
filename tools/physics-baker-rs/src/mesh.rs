use crate::json;
use crate::json::Value;
use crate::sha256::{Sha256, hex};
use crate::spec::{MeshLevel, PlateSpec};

#[derive(Debug, Clone)]
pub struct MeshEvidence {
    pub level_name: String,
    pub target_element_size_m: f64,
    pub radial_divisions: usize,
    pub angular_divisions: usize,
    pub node_count: usize,
    pub triangle_count: usize,
    pub minimum_edge_m: f64,
    pub minimum_signed_area_m2: f64,
    pub maximum_aspect_ratio: f64,
    pub inverted_triangle_count: usize,
    pub connected_component_count: usize,
    pub fingerprint_sha256: String,
}

impl MeshEvidence {
    pub fn to_json(&self) -> Value {
        json!({
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
        })
    }
}

fn mesh_dimensions(radius: f64, hub_radius: f64, target: f64) -> (usize, usize) {
    let angular = ((std::f64::consts::TAU * radius / target).ceil() as usize).max(16);
    let angular_step = std::f64::consts::TAU / angular as f64;
    let radial = ((radius / hub_radius).ln() / angular_step).ceil() as usize;
    (radial.max(4), angular)
}

pub fn build_mesh_evidence(spec: &PlateSpec, level: &MeshLevel) -> Result<MeshEvidence, String> {
    let radius = spec.number(&["geometry", "radiusM"])?;
    let hub_radius = spec.number(&["geometry", "hub", "radiusM"])?;
    let (radial, angular) = mesh_dimensions(radius, hub_radius, level.target_element_size_m);
    let mut nodes = Vec::<(f64, f64)>::with_capacity((radial + 1) * angular);
    let mut digest = Sha256::new();
    for ring in 0..=radial {
        let radius_at_ring = hub_radius * (radius / hub_radius).powf(ring as f64 / radial as f64);
        for sector in 0..angular {
            let theta = std::f64::consts::TAU * sector as f64 / angular as f64;
            let point = (radius_at_ring * theta.cos(), radius_at_ring * theta.sin());
            nodes.push(point);
            digest.update(&point.0.to_le_bytes());
            digest.update(&point.1.to_le_bytes());
        }
    }
    let mut minimum_edge = f64::INFINITY;
    let mut minimum_area = f64::INFINITY;
    let mut maximum_aspect = 0.0_f64;
    let mut inverted = 0;
    let mut triangles = 0;
    for ring in 0..radial {
        let inner = ring * angular;
        let outer = (ring + 1) * angular;
        for sector in 0..angular {
            let next_sector = (sector + 1) % angular;
            let a = inner + sector;
            let b = outer + sector;
            let c = outer + next_sector;
            let d = inner + next_sector;
            for [a, b, c] in [[a, b, c], [a, c, d]] {
                let pa = nodes[a];
                let pb = nodes[b];
                let pc = nodes[c];
                let signed_double_area =
                    (pb.0 - pa.0) * (pc.1 - pa.1) - (pb.1 - pa.1) * (pc.0 - pa.0);
                let area = 0.5 * signed_double_area;
                if area <= 0.0 {
                    inverted += 1;
                }
                let lengths = [distance(pa, pb), distance(pb, pc), distance(pc, pa)];
                let longest = lengths.into_iter().fold(0.0_f64, f64::max);
                let shortest_altitude = 2.0 * area.abs() / longest;
                let aspect = longest / shortest_altitude;
                minimum_edge = minimum_edge.min(lengths.into_iter().fold(f64::INFINITY, f64::min));
                minimum_area = minimum_area.min(area);
                maximum_aspect = maximum_aspect.max(aspect);
                triangles += 1;
                for index in [a, b, c] {
                    digest.update(
                        &u32::try_from(index)
                            .map_err(|_| "mesh index exceeds u32".to_owned())?
                            .to_le_bytes(),
                    );
                }
            }
        }
    }
    Ok(MeshEvidence {
        level_name: level.name.clone(),
        target_element_size_m: level.target_element_size_m,
        radial_divisions: radial,
        angular_divisions: angular,
        node_count: nodes.len(),
        triangle_count: triangles,
        minimum_edge_m: minimum_edge,
        minimum_signed_area_m2: minimum_area,
        maximum_aspect_ratio: maximum_aspect,
        inverted_triangle_count: inverted,
        connected_component_count: 1,
        fingerprint_sha256: hex(&digest.finalize()),
    })
}

pub fn build_mesh_archive(spec: &PlateSpec, level: &MeshLevel) -> Result<Vec<u8>, String> {
    let radius = spec.number(&["geometry", "radiusM"])?;
    let hub_radius = spec.number(&["geometry", "hub", "radiusM"])?;
    let (radial, angular) = mesh_dimensions(radius, hub_radius, level.target_element_size_m);
    let node_count = (radial + 1)
        .checked_mul(angular)
        .ok_or_else(|| "mesh node count overflows".to_owned())?;
    let triangle_count = radial
        .checked_mul(angular)
        .and_then(|value| value.checked_mul(2))
        .ok_or_else(|| "mesh triangle count overflows".to_owned())?;
    let mut raw = Vec::new();
    raw.extend_from_slice(b"MHMESH01");
    for value in [
        1_u32,
        u32::try_from(node_count).map_err(|_| "mesh node count exceeds u32".to_owned())?,
        u32::try_from(triangle_count).map_err(|_| "mesh triangle count exceeds u32".to_owned())?,
        3_u32,
    ] {
        raw.extend_from_slice(&value.to_le_bytes());
    }
    for ring in 0..=radial {
        let radial_position = hub_radius * (radius / hub_radius).powf(ring as f64 / radial as f64);
        for sector in 0..angular {
            let theta = std::f64::consts::TAU * sector as f64 / angular as f64;
            for value in [
                (radial_position * theta.cos()) as f32,
                (radial_position * theta.sin()) as f32,
                0.0_f32,
            ] {
                raw.extend_from_slice(&value.to_le_bytes());
            }
        }
    }
    for ring in 0..radial {
        let inner = ring * angular;
        let outer = (ring + 1) * angular;
        for sector in 0..angular {
            let next_sector = (sector + 1) % angular;
            let a = inner + sector;
            let b = outer + sector;
            let c = outer + next_sector;
            let d = inner + next_sector;
            for index in [a, b, c, a, c, d] {
                raw.extend_from_slice(
                    &u32::try_from(index)
                        .map_err(|_| "mesh index exceeds u32".to_owned())?
                        .to_le_bytes(),
                );
            }
        }
    }
    Ok(zlib_store(&raw))
}

fn distance(left: (f64, f64), right: (f64, f64)) -> f64 {
    (left.0 - right.0).hypot(left.1 - right.1)
}

/// Encodes a standards-compliant zlib stream using deterministic DEFLATE
/// stored blocks. Mesh archives are offline evidence, so avoiding a dynamic
/// compressor dependency is more valuable than a smaller archive here: it
/// keeps the native baker to one executable on App Control machines.
fn zlib_store(bytes: &[u8]) -> Vec<u8> {
    let block_count = bytes.len().div_ceil(u16::MAX as usize).max(1);
    let mut output = Vec::with_capacity(bytes.len() + block_count * 5 + 6);
    // CMF/FLG for DEFLATE, 32 KiB window and fastest/no-compression profile.
    output.extend_from_slice(&[0x78, 0x01]);
    if bytes.is_empty() {
        output.extend_from_slice(&[0x01, 0x00, 0x00, 0xff, 0xff]);
    } else {
        for (index, block) in bytes.chunks(u16::MAX as usize).enumerate() {
            let final_block = index + 1 == block_count;
            output.push(u8::from(final_block));
            let length = block.len() as u16;
            output.extend_from_slice(&length.to_le_bytes());
            output.extend_from_slice(&(!length).to_le_bytes());
            output.extend_from_slice(block);
        }
    }
    output.extend_from_slice(&adler32(bytes).to_be_bytes());
    output
}

fn adler32(bytes: &[u8]) -> u32 {
    const MODULUS: u32 = 65_521;
    let mut first = 1_u32;
    let mut second = 0_u32;
    // 5,552 bytes is the largest chunk that cannot overflow u32 sums.
    for chunk in bytes.chunks(5_552) {
        for byte in chunk {
            first += u32::from(*byte);
            second += first;
        }
        first %= MODULUS;
        second %= MODULUS;
    }
    (second << 16) | first
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stored_zlib_has_valid_header_blocks_and_adler() {
        let source = vec![0x5a; u16::MAX as usize + 7];
        let encoded = zlib_store(&source);
        assert_eq!(&encoded[..2], &[0x78, 0x01]);
        assert_eq!(
            &encoded[encoded.len() - 4..],
            &adler32(&source).to_be_bytes()
        );
        assert_eq!(encoded[2] & 1, 0);
        let second_header = 2 + 5 + u16::MAX as usize;
        assert_eq!(encoded[second_header] & 1, 1);
    }
}
