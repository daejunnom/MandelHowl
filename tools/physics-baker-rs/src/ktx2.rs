use crate::mesh::zlib_compress;

const IDENTIFIER: [u8; 12] = [
    0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a,
];
const VK_FORMAT_R8_UNORM: u32 = 9;
const VK_FORMAT_R8G8_UNORM: u32 = 16;

pub fn write_ktx2_array(
    width: usize,
    height: usize,
    layers: usize,
    channels: usize,
    image_data: &[u8],
) -> Result<Vec<u8>, String> {
    if width == 0 || height == 0 || layers == 0 || !matches!(channels, 1 | 2) {
        return Err("KTX2 dimensions, layers, or channel count are invalid".to_owned());
    }
    let expected = width
        .checked_mul(height)
        .and_then(|value| value.checked_mul(layers))
        .and_then(|value| value.checked_mul(channels))
        .ok_or_else(|| "KTX2 dimensions overflow".to_owned())?;
    if image_data.len() != expected {
        return Err(format!(
            "expected {expected} KTX2 image bytes, received {}",
            image_data.len()
        ));
    }
    let encoded_image_data = zlib_compress(image_data);
    if encoded_image_data.len() >= image_data.len() {
        return Err(format!(
            "KTX2 ZLIB supercompression did not reduce the level: {} encoded bytes for {} raw bytes",
            encoded_image_data.len(),
            image_data.len()
        ));
    }
    let width = u32::try_from(width).map_err(|_| "KTX2 width exceeds u32".to_owned())?;
    let height = u32::try_from(height).map_err(|_| "KTX2 height exceeds u32".to_owned())?;
    let layers = u32::try_from(layers).map_err(|_| "KTX2 layers exceed u32".to_owned())?;
    let vk_format = if channels == 1 {
        VK_FORMAT_R8_UNORM
    } else {
        VK_FORMAT_R8G8_UNORM
    };
    let dfd = data_format_descriptor(channels)?;
    let mut kvd = Vec::new();
    kvd.extend_from_slice(&key_value_entry("KTXorientation", b"ru\0")?);
    kvd.extend_from_slice(&key_value_entry(
        "KTXwriter",
        b"MandelHowl physics-baker 1.0.0\0",
    )?);
    let header_bytes = 80_usize;
    let level_index_bytes = 24_usize;
    let dfd_offset = header_bytes + level_index_bytes;
    let kvd_offset = dfd_offset + dfd.len();
    let unaligned_data_offset = kvd_offset + kvd.len();
    let alignment = 4_usize;
    let data_offset = unaligned_data_offset.div_ceil(alignment) * alignment;

    let mut output = Vec::with_capacity(data_offset + encoded_image_data.len());
    output.extend_from_slice(&IDENTIFIER);
    for value in [
        vk_format,
        1,
        width,
        height,
        0,
        layers,
        1,
        1,
        3,
        u32::try_from(dfd_offset).map_err(|_| "KTX2 DFD offset exceeds u32".to_owned())?,
        u32::try_from(dfd.len()).map_err(|_| "KTX2 DFD length exceeds u32".to_owned())?,
        u32::try_from(kvd_offset).map_err(|_| "KTX2 KVD offset exceeds u32".to_owned())?,
        u32::try_from(kvd.len()).map_err(|_| "KTX2 KVD length exceeds u32".to_owned())?,
    ] {
        output.extend_from_slice(&value.to_le_bytes());
    }
    output.extend_from_slice(&0_u64.to_le_bytes());
    output.extend_from_slice(&0_u64.to_le_bytes());
    output.extend_from_slice(&(data_offset as u64).to_le_bytes());
    output.extend_from_slice(&(encoded_image_data.len() as u64).to_le_bytes());
    output.extend_from_slice(&(image_data.len() as u64).to_le_bytes());
    output.extend_from_slice(&dfd);
    output.extend_from_slice(&kvd);
    output.resize(data_offset, 0);
    output.extend_from_slice(&encoded_image_data);
    Ok(output)
}

fn data_format_descriptor(channels: usize) -> Result<Vec<u8>, String> {
    if !matches!(channels, 1 | 2) {
        return Err("KTX2 DFD supports one or two channels".to_owned());
    }
    let block_size = 24 + 16 * channels;
    let mut output = Vec::with_capacity(4 + block_size);
    output.extend_from_slice(&((4 + block_size) as u32).to_le_bytes());
    output.extend_from_slice(&0_u32.to_le_bytes());
    output.extend_from_slice(&2_u16.to_le_bytes());
    output.extend_from_slice(&(block_size as u16).to_le_bytes());
    output.extend_from_slice(&[1, 1, 1, 0]);
    output.extend_from_slice(&[0, 0, 0, 0]);
    output.extend_from_slice(&[channels as u8, 0, 0, 0, 0, 0, 0, 0]);
    for channel in 0..channels {
        output.extend_from_slice(&((channel * 8) as u16).to_le_bytes());
        output.push(7);
        output.push(channel as u8);
        output.extend_from_slice(&[0, 0, 0, 0]);
        output.extend_from_slice(&0_u32.to_le_bytes());
        output.extend_from_slice(&255_u32.to_le_bytes());
    }
    Ok(output)
}

fn key_value_entry(key: &str, value: &[u8]) -> Result<Vec<u8>, String> {
    if key.as_bytes().contains(&0) {
        return Err("KTX2 key contains NUL".to_owned());
    }
    let payload_length = key
        .len()
        .checked_add(1)
        .and_then(|length| length.checked_add(value.len()))
        .ok_or_else(|| "KTX2 key/value length overflows".to_owned())?;
    let mut output = Vec::with_capacity(4 + payload_length + 3);
    output.extend_from_slice(
        &u32::try_from(payload_length)
            .map_err(|_| "KTX2 key/value length exceeds u32".to_owned())?
            .to_le_bytes(),
    );
    output.extend_from_slice(key.as_bytes());
    output.push(0);
    output.extend_from_slice(value);
    output.resize(output.len().div_ceil(4) * 4, 0);
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mesh::zlib_decompress;

    fn u32_at(bytes: &[u8], offset: usize) -> u32 {
        u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
    }

    fn u64_at(bytes: &[u8], offset: usize) -> u64 {
        u64::from_le_bytes(bytes[offset..offset + 8].try_into().unwrap())
    }

    #[test]
    fn writes_portable_zlib_supercompressed_array() {
        let pixels = (0..(32 * 32 * 4))
            .map(|index| ((index / 16) % 251) as u8)
            .collect::<Vec<_>>();
        let encoded = write_ktx2_array(32, 32, 4, 1, &pixels).unwrap();
        assert_eq!(u32_at(&encoded, 44), 3);
        let level_offset = u64_at(&encoded, 80) as usize;
        let level_length = u64_at(&encoded, 88) as usize;
        let raw_length = u64_at(&encoded, 96) as usize;
        assert!(level_length < raw_length);
        assert_eq!(raw_length, pixels.len());
        assert_eq!(
            zlib_decompress(&encoded[level_offset..level_offset + level_length]).unwrap(),
            pixels
        );
    }
}
