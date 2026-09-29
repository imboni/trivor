//! Lossless GLB packaging, including compressed buffers and extension metadata.

use std::borrow::Cow;
use std::path::Path;

use gltf::binary::{Glb, Header};
use serde_json::{json, Value};

use crate::asset_uri::{parse_error, read_asset};
use crate::{cache, LoadError};

fn pad4(bytes: &mut Vec<u8>) {
    while bytes.len() % 4 != 0 {
        bytes.push(0);
    }
}

fn remap_buffer(
    view: &mut Value,
    mappings: &[(usize, usize)],
    lengths: &[usize],
    source: &Path,
) -> Result<(), LoadError> {
    let index = view["buffer"]
        .as_u64()
        .ok_or_else(|| parse_error(source, "missing buffer index"))? as usize;
    let offset = view["byteOffset"].as_u64().unwrap_or(0) as usize;
    let length = view["byteLength"]
        .as_u64()
        .ok_or_else(|| parse_error(source, "missing buffer length"))? as usize;
    let buffer_length = lengths
        .get(index)
        .ok_or_else(|| parse_error(source, "buffer index out of range"))?;
    if offset
        .checked_add(length)
        .map_or(true, |end| end > *buffer_length)
    {
        return Err(parse_error(source, "buffer view out of range"));
    }
    view["buffer"] = json!(mappings[index].0);
    view["byteOffset"] = json!(mappings[index].1 + offset);
    Ok(())
}

fn image_mime(image: &Value, uri: &str, bytes: &[u8], source: &Path) -> Result<String, LoadError> {
    if let Some(mime) = image["mimeType"].as_str() {
        return Ok(mime.to_string());
    }
    if let Some(data) = uri.strip_prefix("data:") {
        let mime = data.split([';', ',']).next().unwrap_or("");
        if mime.starts_with("image/") {
            return Ok(mime.to_string());
        }
    }
    let mime = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        "image/jpeg"
    } else if bytes.starts_with(b"\xabKTX 20\xbb\r\n\x1a\n") {
        "image/ktx2"
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        "image/webp"
    } else {
        return Err(parse_error(source, "cannot identify texture MIME type"));
    };
    Ok(mime.to_string())
}

fn pack_gltf(source: &Path) -> Result<Vec<u8>, LoadError> {
    let bytes = std::fs::read(source).map_err(|e| LoadError::Io {
        path: source.to_path_buf(),
        message: e.to_string(),
    })?;
    let (json_bytes, blob) = if bytes.starts_with(b"glTF") {
        let glb = Glb::from_slice(&bytes).map_err(|e| parse_error(source, e.to_string()))?;
        (glb.json.into_owned(), glb.bin.map(Cow::into_owned))
    } else {
        (bytes, None)
    };
    let mut doc: Value =
        serde_json::from_slice(&json_bytes).map_err(|e| parse_error(source, e.to_string()))?;
    if doc["asset"]["version"].as_str() != Some("2.0") {
        return Err(parse_error(source, "expected glTF 2.0"));
    }
    let mut bin = Vec::new();
    let mut mappings = Vec::new();
    let mut fallback_buffers = Vec::new();
    let mut lengths = Vec::new();
    for (index, buffer) in doc["buffers"].as_array().into_iter().flatten().enumerate() {
        let length = buffer["byteLength"]
            .as_u64()
            .ok_or_else(|| parse_error(source, "missing buffer length"))?
            as usize;
        // Meshopt's virtual fallback buffer must remain virtual; allocating it would
        // expand compressed models to their full decoded size during export.
        if buffer.get("uri").is_none()
            && !(index == 0 && blob.is_some())
            && buffer["extensions"]["EXT_meshopt_compression"]["fallback"].as_bool() == Some(true)
        {
            fallback_buffers.push(buffer.clone());
            mappings.push((fallback_buffers.len(), 0));
            lengths.push(length);
            continue;
        }
        let data = if let Some(uri) = buffer["uri"].as_str() {
            read_asset(source, uri)?
        } else if index == 0 && blob.is_some() {
            blob.as_ref().unwrap().clone()
        } else {
            return Err(parse_error(source, "buffer has no URI or GLB payload"));
        };
        if data.len() < length {
            return Err(parse_error(source, "buffer is shorter than byteLength"));
        }
        pad4(&mut bin);
        mappings.push((0, bin.len()));
        lengths.push(length);
        bin.extend_from_slice(&data[..length]);
    }
    if let Some(views) = doc["bufferViews"].as_array_mut() {
        for view in views {
            remap_buffer(view, &mappings, &lengths, source)?;
            if let Some(meshopt) = view
                .get_mut("extensions")
                .and_then(|e| e.get_mut("EXT_meshopt_compression"))
            {
                remap_buffer(meshopt, &mappings, &lengths, source)?;
            }
        }
    }
    let mut views = doc["bufferViews"].as_array().cloned().unwrap_or_default();
    if let Some(images) = doc["images"].as_array_mut() {
        for image in images {
            let Some(uri) = image["uri"].as_str() else {
                continue;
            };
            let data = read_asset(source, uri)?;
            let mime = image_mime(image, uri, &data, source)?;
            pad4(&mut bin);
            views.push(json!({ "buffer": 0, "byteOffset": bin.len(), "byteLength": data.len() }));
            bin.extend_from_slice(&data);
            image.as_object_mut().unwrap().remove("uri");
            image["bufferView"] = json!(views.len() - 1);
            image["mimeType"] = json!(mime);
        }
    }
    if !views.is_empty() {
        doc["bufferViews"] = Value::Array(views);
    }
    if !bin.is_empty() {
        let mut buffers = vec![json!({ "byteLength": bin.len() })];
        buffers.extend(fallback_buffers);
        doc["buffers"] = Value::Array(buffers);
    } else {
        doc.as_object_mut().unwrap().remove("buffers");
    }
    let glb = Glb {
        header: Header {
            magic: *b"glTF",
            version: 2,
            length: 0,
        },
        json: Cow::Owned(serde_json::to_vec(&doc).map_err(|e| parse_error(source, e.to_string()))?),
        bin: if bin.is_empty() {
            None
        } else {
            Some(Cow::Owned(bin))
        },
    };
    glb.to_vec().map_err(|e| parse_error(source, e.to_string()))
}

/// Export the original model, preserving geometry and compressed data without preview simplification.
pub fn export_model_glb(source: &Path, dest: &Path) -> Result<(), LoadError> {
    let source = source.canonicalize().map_err(|e| LoadError::Io {
        path: source.to_path_buf(),
        message: e.to_string(),
    })?;
    let ext = source
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let imported;
    let gltf = match ext.as_str() {
        "gltf" | "glb" => &source,
        "obj" => {
            imported = crate::gltf_import::import_obj_to_cache(&source, None)?;
            &imported
        }
        "stl" => {
            imported = crate::gltf_import::import_stl_to_cache(&source, None)?;
            &imported
        }
        _ => return Err(LoadError::UnsupportedFormat(ext)),
    };
    let bytes = pack_gltf(gltf)?;
    // Resolve existing symlinks before replacement, as native save dialogs overwrite their target.
    let dest = dest.canonicalize().unwrap_or_else(|_| dest.to_path_buf());
    cache::write_atomic(&dest, |temp| {
        std::fs::write(temp, &bytes).map_err(|e| LoadError::Io {
            path: dest.clone(),
            message: e.to_string(),
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cache::tests::TempDir;

    #[test]
    fn preserves_meshopt_virtual_fallback_without_expanding_payload() {
        let dir = TempDir::new();
        let source = dir.0.join("mesh.gltf");
        std::fs::write(dir.0.join("mesh.bin"), [1, 2, 3, 4]).unwrap();
        let doc = json!({
            "asset": {"version": "2.0"},
            "extensionsRequired": ["EXT_meshopt_compression"],
            "buffers": [{"byteLength":4,"uri":"mesh.bin"},{"byteLength": 1000000,"extensions":{"EXT_meshopt_compression":{"fallback":true}}}],
            "bufferViews": [{"buffer":1,"byteLength":1000000,"extensions":{"EXT_meshopt_compression":{"buffer":0,"byteLength":4,"byteStride":4,"count":250000,"mode":"ATTRIBUTES"}}}]
        });
        std::fs::write(&source, serde_json::to_vec(&doc).unwrap()).unwrap();
        let bytes = pack_gltf(&source).unwrap();
        let glb = Glb::from_slice(&bytes).unwrap();
        let output: Value = serde_json::from_slice(&glb.json).unwrap();
        assert_eq!(glb.bin.unwrap().len(), 4);
        assert_eq!(output["bufferViews"][0]["buffer"], 1);
        assert_eq!(output["buffers"][1], doc["buffers"][1]);
    }

    #[test]
    fn exports_compressed_gltf_with_external_buffers_and_basis_texture() {
        let dir = TempDir::new();
        let source = dir.0.join("mesh.gltf");
        std::fs::write(dir.0.join("first.bin"), [1, 2, 3, 4]).unwrap();
        std::fs::write(dir.0.join("second buffer.bin"), [5, 6, 7, 8]).unwrap();
        let texture = b"\xabKTX 20\xbb\r\n\x1a\ntexture";
        std::fs::write(dir.0.join("texture.ktx2"), texture).unwrap();
        let doc = json!({
            "asset": {"version": "2.0"},
            "extensionsUsed": ["EXT_meshopt_compression", "KHR_texture_basisu"],
            "extensionsRequired": ["EXT_meshopt_compression", "KHR_texture_basisu"],
            "buffers": [{"byteLength":4,"uri":"first.bin"},{"byteLength":4,"uri":"second%20buffer.bin"}],
            "bufferViews": [{"buffer":0,"byteLength":4,"extensions":{"EXT_meshopt_compression":{"buffer":1,"byteOffset":0,"byteLength":4,"byteStride":4,"count":1,"mode":"ATTRIBUTES"}}}],
            "images":[{"uri":"texture.ktx2"}],
            "textures":[{"extensions":{"KHR_texture_basisu":{"source":0}}}]
        });
        std::fs::write(&source, serde_json::to_vec(&doc).unwrap()).unwrap();
        let dest = dir.0.join("export.glb");
        export_model_glb(&source, &dest).unwrap();
        let bytes = std::fs::read(&dest).unwrap();
        let glb = Glb::from_slice(&bytes).unwrap();
        let output: Value = serde_json::from_slice(&glb.json).unwrap();
        assert_eq!(output["extensionsRequired"], doc["extensionsRequired"]);
        assert_eq!(
            output["bufferViews"][0]["extensions"]["EXT_meshopt_compression"]["byteOffset"],
            4
        );
        assert_eq!(output["images"][0]["mimeType"], "image/ktx2");
        assert!(output["images"][0].get("uri").is_none());
        assert_eq!(&glb.bin.unwrap()[8..8 + texture.len()], texture);
        // Exporting over the source itself must not truncate it.
        export_model_glb(&dest, &dest).unwrap();
        assert!(cache::valid_glb(&dest));
    }
}
