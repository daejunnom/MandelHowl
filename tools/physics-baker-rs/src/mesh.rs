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
    Ok(zlib_compress(&raw))
}

fn distance(left: (f64, f64), right: (f64, f64)) -> f64 {
    (left.0 - right.0).hypot(left.1 - right.1)
}

/// Encodes a standards-compliant zlib stream without a native compression
/// dependency. The fixed-Huffman LZ77 path keeps the native baker to one
/// executable on App Control machines while still producing useful KTX2
/// supercompression. A stored stream is retained as the deterministic
/// worst-case fallback.
pub(crate) fn zlib_compress(bytes: &[u8]) -> Vec<u8> {
    let fixed = zlib_fixed(bytes);
    let stored = zlib_store(bytes);
    if fixed.len() < stored.len() {
        fixed
    } else {
        stored
    }
}

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

fn zlib_fixed(bytes: &[u8]) -> Vec<u8> {
    const EMPTY: usize = usize::MAX;
    const HASH_SIZE: usize = 1 << 16;
    const MAX_CHAIN: usize = 96;
    const MAX_DISTANCE: usize = 32_768;
    const MAX_LENGTH: usize = 258;

    let mut writer = BitWriter::default();
    writer.write_bits(1, 1); // BFINAL
    writer.write_bits(1, 2); // BTYPE=01, fixed Huffman

    let mut heads = vec![EMPTY; HASH_SIZE];
    let mut previous = vec![EMPTY; bytes.len()];
    let mut cursor = 0_usize;
    while cursor < bytes.len() {
        let mut best_length = 0_usize;
        let mut best_distance = 0_usize;
        if cursor + 2 < bytes.len() {
            let hash = hash_three(bytes, cursor);
            let mut candidate = heads[hash];
            let mut searched = 0_usize;
            while candidate != EMPTY && cursor - candidate <= MAX_DISTANCE && searched < MAX_CHAIN {
                if bytes[candidate] == bytes[cursor]
                    && bytes[candidate + 1] == bytes[cursor + 1]
                    && bytes[candidate + 2] == bytes[cursor + 2]
                {
                    let limit = MAX_LENGTH.min(bytes.len() - cursor);
                    let mut length = 3_usize;
                    while length < limit && bytes[candidate + length] == bytes[cursor + length] {
                        length += 1;
                    }
                    if length > best_length {
                        best_length = length;
                        best_distance = cursor - candidate;
                        if length == limit {
                            break;
                        }
                    }
                }
                candidate = previous[candidate];
                searched += 1;
            }
        }

        if best_length >= 3 {
            write_fixed_length_distance(&mut writer, best_length, best_distance);
            let match_end = cursor + best_length;
            while cursor < match_end {
                if cursor + 2 < bytes.len() {
                    let hash = hash_three(bytes, cursor);
                    previous[cursor] = heads[hash];
                    heads[hash] = cursor;
                }
                cursor += 1;
            }
        } else {
            write_fixed_symbol(&mut writer, u16::from(bytes[cursor]));
            if cursor + 2 < bytes.len() {
                let hash = hash_three(bytes, cursor);
                previous[cursor] = heads[hash];
                heads[hash] = cursor;
            }
            cursor += 1;
        }
    }
    write_fixed_symbol(&mut writer, 256);

    let mut output = Vec::with_capacity(writer.bytes.len() + 6);
    // CMF/FLG for DEFLATE, 32 KiB window and maximum-compression profile.
    output.extend_from_slice(&[0x78, 0xda]);
    output.extend_from_slice(&writer.finish());
    output.extend_from_slice(&adler32(bytes).to_be_bytes());
    output
}

fn hash_three(bytes: &[u8], offset: usize) -> usize {
    let value = (u32::from(bytes[offset]) << 16)
        | (u32::from(bytes[offset + 1]) << 8)
        | u32::from(bytes[offset + 2]);
    ((value.wrapping_mul(2_654_435_761) >> 16) as usize) & 0xffff
}

fn write_fixed_length_distance(writer: &mut BitWriter, length: usize, distance: usize) {
    const LENGTH_BASE: [usize; 29] = [
        3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115,
        131, 163, 195, 227, 258,
    ];
    const LENGTH_EXTRA: [u8; 29] = [
        0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
    ];
    const DISTANCE_BASE: [usize; 30] = [
        1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537,
        2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
    ];
    const DISTANCE_EXTRA: [u8; 30] = [
        0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12,
        13, 13,
    ];

    let length_index = LENGTH_BASE
        .iter()
        .enumerate()
        .find(|(index, base)| {
            let extra = LENGTH_EXTRA[*index];
            let maximum = **base + ((1_usize << extra) - 1);
            length <= maximum
        })
        .map(|(index, _)| index)
        .expect("DEFLATE match length is in range");
    write_fixed_symbol(writer, 257 + length_index as u16);
    let length_extra = LENGTH_EXTRA[length_index];
    if length_extra > 0 {
        writer.write_bits((length - LENGTH_BASE[length_index]) as u32, length_extra);
    }

    let distance_index = DISTANCE_BASE
        .iter()
        .enumerate()
        .find(|(index, base)| {
            let extra = DISTANCE_EXTRA[*index];
            let maximum = **base + ((1_usize << extra) - 1);
            distance <= maximum
        })
        .map(|(index, _)| index)
        .expect("DEFLATE match distance is in range");
    writer.write_bits(reverse_bits(distance_index as u16, 5), 5);
    let distance_extra = DISTANCE_EXTRA[distance_index];
    if distance_extra > 0 {
        writer.write_bits(
            (distance - DISTANCE_BASE[distance_index]) as u32,
            distance_extra,
        );
    }
}

fn write_fixed_symbol(writer: &mut BitWriter, symbol: u16) {
    let (code, bit_count) = match symbol {
        0..=143 => (symbol + 0x30, 8),
        144..=255 => (symbol - 144 + 0x190, 9),
        256..=279 => (symbol - 256, 7),
        280..=287 => (symbol - 280 + 0xc0, 8),
        _ => panic!("fixed-Huffman symbol is out of range"),
    };
    writer.write_bits(reverse_bits(code, bit_count), bit_count);
}

fn reverse_bits(value: u16, bit_count: u8) -> u32 {
    u32::from(value.reverse_bits() >> (16 - bit_count))
}

#[derive(Default)]
struct BitWriter {
    bytes: Vec<u8>,
    pending: u64,
    pending_bits: u8,
}

impl BitWriter {
    fn write_bits(&mut self, value: u32, bit_count: u8) {
        debug_assert!(bit_count <= 24);
        self.pending |= u64::from(value) << self.pending_bits;
        self.pending_bits += bit_count;
        while self.pending_bits >= 8 {
            self.bytes.push(self.pending as u8);
            self.pending >>= 8;
            self.pending_bits -= 8;
        }
    }

    fn finish(mut self) -> Vec<u8> {
        if self.pending_bits > 0 {
            self.bytes.push(self.pending as u8);
        }
        self.bytes
    }
}

pub(crate) fn zlib_decompress(bytes: &[u8]) -> Result<Vec<u8>, String> {
    if bytes.len() < 6 {
        return Err("zlib stream is truncated".to_owned());
    }
    let cmf = bytes[0];
    let flg = bytes[1];
    if cmf & 0x0f != 8 || cmf >> 4 > 7 {
        return Err("zlib stream does not use DEFLATE with a valid window".to_owned());
    }
    if (u16::from(cmf) * 256 + u16::from(flg)) % 31 != 0 {
        return Err("zlib FCHECK is invalid".to_owned());
    }
    if flg & 0x20 != 0 {
        return Err("zlib preset dictionaries are not supported".to_owned());
    }
    let expected_adler = u32::from_be_bytes(
        bytes[bytes.len() - 4..]
            .try_into()
            .map_err(|_| "zlib Adler-32 is truncated".to_owned())?,
    );
    let mut reader = BitReader::new(&bytes[2..bytes.len() - 4]);
    let mut output = Vec::new();
    loop {
        let final_block = reader.read_bits(1)? != 0;
        match reader.read_bits(2)? {
            0 => {
                reader.align_to_byte();
                let length = reader.read_bits(16)? as u16;
                let inverse = reader.read_bits(16)? as u16;
                if length != !inverse {
                    return Err("DEFLATE stored block LEN/NLEN mismatch".to_owned());
                }
                for _ in 0..length {
                    output.push(reader.read_bits(8)? as u8);
                }
            }
            1 => decode_fixed_block(&mut reader, &mut output)?,
            2 => {
                return Err(
                    "dynamic-Huffman DEFLATE is outside the deterministic baker profile".to_owned(),
                );
            }
            _ => return Err("reserved DEFLATE block type".to_owned()),
        }
        if final_block {
            break;
        }
    }
    if adler32(&output) != expected_adler {
        return Err("zlib Adler-32 mismatch".to_owned());
    }
    Ok(output)
}

fn decode_fixed_block(reader: &mut BitReader<'_>, output: &mut Vec<u8>) -> Result<(), String> {
    const LENGTH_BASE: [usize; 29] = [
        3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115,
        131, 163, 195, 227, 258,
    ];
    const LENGTH_EXTRA: [u8; 29] = [
        0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
    ];
    const DISTANCE_BASE: [usize; 30] = [
        1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537,
        2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
    ];
    const DISTANCE_EXTRA: [u8; 30] = [
        0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12,
        13, 13,
    ];

    loop {
        let symbol = read_fixed_symbol(reader)?;
        match symbol {
            0..=255 => output.push(symbol as u8),
            256 => return Ok(()),
            257..=285 => {
                let length_index = usize::from(symbol - 257);
                let extra = LENGTH_EXTRA[length_index];
                let length = LENGTH_BASE[length_index] + reader.read_bits(extra)? as usize;
                let mut distance_symbol = 0_u16;
                for _ in 0..5 {
                    distance_symbol = (distance_symbol << 1) | reader.read_bits(1)? as u16;
                }
                if distance_symbol >= 30 {
                    return Err("reserved DEFLATE distance symbol".to_owned());
                }
                let distance_index = usize::from(distance_symbol);
                let extra = DISTANCE_EXTRA[distance_index];
                let distance = DISTANCE_BASE[distance_index] + reader.read_bits(extra)? as usize;
                if distance == 0 || distance > output.len() {
                    return Err("DEFLATE match distance exceeds decoded output".to_owned());
                }
                for _ in 0..length {
                    let byte = output[output.len() - distance];
                    output.push(byte);
                }
            }
            _ => return Err("reserved DEFLATE length symbol".to_owned()),
        }
    }
}

fn read_fixed_symbol(reader: &mut BitReader<'_>) -> Result<u16, String> {
    let mut code = 0_u16;
    for bit_count in 1..=9_u8 {
        code = (code << 1) | reader.read_bits(1)? as u16;
        match bit_count {
            7 if code <= 0x17 => return Ok(256 + code),
            8 if (0x30..=0xbf).contains(&code) => return Ok(code - 0x30),
            8 if (0xc0..=0xc7).contains(&code) => return Ok(280 + code - 0xc0),
            9 if (0x190..=0x1ff).contains(&code) => return Ok(144 + code - 0x190),
            _ => {}
        }
    }
    Err("invalid fixed-Huffman symbol".to_owned())
}

struct BitReader<'a> {
    bytes: &'a [u8],
    bit_offset: usize,
}

impl<'a> BitReader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self {
            bytes,
            bit_offset: 0,
        }
    }

    fn read_bits(&mut self, bit_count: u8) -> Result<u32, String> {
        let mut value = 0_u32;
        for bit_index in 0..bit_count {
            let byte_index = self.bit_offset / 8;
            if byte_index >= self.bytes.len() {
                return Err("DEFLATE bitstream is truncated".to_owned());
            }
            let source_bit = (self.bytes[byte_index] >> (self.bit_offset % 8)) & 1;
            value |= u32::from(source_bit) << bit_index;
            self.bit_offset += 1;
        }
        Ok(value)
    }

    fn align_to_byte(&mut self) {
        self.bit_offset = self.bit_offset.div_ceil(8) * 8;
    }
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

    #[test]
    fn fixed_zlib_round_trips_and_compresses_repetition() {
        let source = (0..65_536)
            .map(|index| ((index / 32) % 251) as u8)
            .collect::<Vec<_>>();
        let encoded = zlib_compress(&source);
        assert_eq!(&encoded[..2], &[0x78, 0xda]);
        assert!(encoded.len() < source.len());
        assert_eq!(zlib_decompress(&encoded).unwrap(), source);
    }

    #[test]
    fn stored_zlib_round_trips() {
        let source = (0..65_537)
            .map(|index| ((index * 193 + 17) % 256) as u8)
            .collect::<Vec<_>>();
        assert_eq!(zlib_decompress(&zlib_store(&source)).unwrap(), source);
    }
}
