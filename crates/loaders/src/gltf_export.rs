//! Lossless GLB packaging, including compressed buffers and extension metadata.

use std::borrow::Cow;
use std::path::Path;

use gltf::binary::{Glb, Header};
use serde_json::{json, Value};

use crate::asset_uri::{parse_error, read_asset};
use crate::LoadError;

fn pad4(bytes: &mut Vec<u8>) {
    while bytes.len() % 4 != 0 {
        bytes.push(0);
    }
}

fn check_glb_length(
    json_len: usize,
    bin_len: Option<usize>,
    source: &Path,
) -> Result<(), LoadError> {
    let padded = |length: usize| length.checked_add(3).map(|length| length & !3);
    let length = padded(json_len)
        .and_then(|length| length.checked_add(20)) // GLB header and JSON chunk header.
        .and_then(|length| match bin_len {
            Some(bin_len) => padded(bin_len)
                .and_then(|bin_len| bin_len.checked_add(8))
                .and_then(|bin_len| length.checked_add(bin_len)),
            None => Some(length),
        });
    if length.is_none_or(|length| length > u32::MAX as usize) {
        return Err(parse_error(
            source,
            "packed GLB exceeds the 4 GiB format limit",
        ));
    }
    Ok(())
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

pub(crate) fn pack_gltf(source: &Path) -> Result<Vec<u8>, LoadError> {
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
    if let Some(views) = doc.get_mut("bufferViews").and_then(Value::as_array_mut) {
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
    if let Some(images) = doc.get_mut("images").and_then(Value::as_array_mut) {
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
    let json = serde_json::to_vec(&doc).map_err(|e| parse_error(source, e.to_string()))?;
    // gltf-rs casts chunk/total lengths to u32 without checking for truncation.
    check_glb_length(json.len(), (!bin.is_empty()).then_some(bin.len()), source)?;
    let glb = Glb {
        header: Header {
            magic: *b"glTF",
            version: 2,
            length: 0,
        },
        json: Cow::Owned(json),
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
    // Finish conversion before touching the chosen file, including in-place exports.
    let bytes = pack_gltf(gltf)?;
    // NSSavePanel grants access to this file, not arbitrary siblings in its directory.
    // Atomic cache writes remain appropriate inside the app's own cache container.
    std::fs::write(dest, &bytes).map_err(|e| LoadError::Io {
        path: dest.to_path_buf(),
        message: e.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cache::{self, tests::TempDir};
    use std::path::PathBuf;

    #[test]
    fn glb_length_checks_headers_padding_and_overflow_without_allocating() {
        let source = Path::new("large.gltf");
        let max_aligned = (u32::MAX as usize) & !3;
        assert!(check_glb_length(max_aligned - 20, None, source).is_ok());
        assert!(check_glb_length(max_aligned - 19, None, source).is_err());
        // Four JSON bytes leave 32 bytes of headers/JSON before the BIN payload.
        assert!(check_glb_length(4, Some(max_aligned - 32), source).is_ok());
        assert!(check_glb_length(4, Some(max_aligned - 31), source).is_err());
        assert!(check_glb_length(usize::MAX, None, source).is_err());
        assert!(check_glb_length(4, Some(usize::MAX), source).is_err());
    }

    fn write_standard_cube_fixture(dir: &Path, textured: bool) -> PathBuf {
        // Match the native fixture that exposed images:null: 8 vertices and 12 faces.
        let positions: [[f32; 3]; 8] = [
            [-1.0, -0.6, -0.4],
            [1.0, -0.6, -0.4],
            [1.0, 0.6, -0.4],
            [-1.0, 0.6, -0.4],
            [-1.0, -0.6, 0.4],
            [1.0, -0.6, 0.4],
            [1.0, 0.6, 0.4],
            [-1.0, 0.6, 0.4],
        ];
        let indices: [u16; 36] = [
            0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7,
            3, 1, 2, 6, 1, 6, 5,
        ];
        let mut bin = Vec::new();
        for component in positions.iter().flatten() {
            bin.extend_from_slice(&component.to_le_bytes());
        }
        for index in indices {
            bin.extend_from_slice(&index.to_le_bytes());
        }
        let mut doc = json!({
            "asset": {"version":"2.0"}, "scene":0, "scenes":[{"nodes":[0]}],
            "nodes":[{"mesh":0}],
            "meshes":[{"primitives":[{"attributes":{"POSITION":0},"indices":1,"material":0}]}],
            "materials":[{"pbrMetallicRoughness":{"baseColorFactor":[0.7,0.2,0.1,1],"metallicFactor":0,"roughnessFactor":0.7}}],
            "buffers":[{"byteLength":168,"uri":"geometry.bin"}],
            "bufferViews":[{"buffer":0,"byteLength":96},{"buffer":0,"byteOffset":96,"byteLength":72}],
            "accessors":[
                {"bufferView":0,"componentType":5126,"count":8,"type":"VEC3","min":[-1,-0.6,-0.4],"max":[1,0.6,0.4]},
                {"bufferView":1,"componentType":5123,"count":36,"type":"SCALAR"}
            ]
        });
        if textured {
            let uv: [[f32; 2]; 8] = [
                [0.0, 0.0],
                [1.0, 0.0],
                [1.0, 1.0],
                [0.0, 1.0],
                [0.0, 0.0],
                [1.0, 0.0],
                [1.0, 1.0],
                [0.0, 1.0],
            ];
            for component in uv.iter().flatten() {
                bin.extend_from_slice(&component.to_le_bytes());
            }
            doc["buffers"][0]["byteLength"] = json!(bin.len());
            doc["bufferViews"]
                .as_array_mut()
                .unwrap()
                .push(json!({"buffer":0,"byteOffset":168,"byteLength":64}));
            doc["accessors"]
                .as_array_mut()
                .unwrap()
                .push(json!({"bufferView":2,"componentType":5126,"count":8,"type":"VEC2"}));
            doc["meshes"][0]["primitives"][0]["attributes"]["TEXCOORD_0"] = json!(2);
            doc["materials"][0]["pbrMetallicRoughness"]["baseColorTexture"] = json!({"index":0});
            doc["textures"] = json!([{"source":0}]);
            doc["images"] = json!([{"uri":"texture.png"}]);
            image::RgbaImage::from_pixel(2, 2, image::Rgba([255, 180, 120, 255]))
                .save(dir.join("texture.png"))
                .unwrap();
        }
        std::fs::write(dir.join("geometry.bin"), &bin).unwrap();
        let source = dir.join("cube.gltf");
        std::fs::write(&source, serde_json::to_vec(&doc).unwrap()).unwrap();
        source
    }

    #[test]
    fn standard_cube_exports_validate_with_and_without_textures() {
        for textured in [false, true] {
            let dir = TempDir::new();
            let source = write_standard_cube_fixture(&dir.0, textured);
            let dest = dir.0.join("cube.glb");
            export_model_glb(&source, &dest).unwrap();
            std::fs::remove_file(dir.0.join("geometry.bin")).unwrap();
            if textured {
                std::fs::remove_file(dir.0.join("texture.png")).unwrap();
            }
            // Exercise both glTF -> GLB and the native GLB -> GLB export path.
            for _ in 0..2 {
                let bytes = std::fs::read(&dest).unwrap();
                let gltf = gltf::Gltf::from_slice(&bytes)
                    .expect("standard exported GLB must pass schema validation");
                assert_eq!(gltf.meshes().len(), 1);
                assert_eq!(gltf.accessors().next().unwrap().count(), 8);
                assert_eq!(gltf.images().len(), usize::from(textured));
                let (_, buffers, images) = gltf::import_slice(&bytes)
                    .expect("GLB must be usable without its original sidecars");
                assert_eq!(buffers.len(), 1);
                assert_eq!(images.len(), usize::from(textured));
                let glb = Glb::from_slice(&bytes).unwrap();
                let output: Value = serde_json::from_slice(&glb.json).unwrap();
                if !textured {
                    assert!(output.get("images").is_none());
                }
                export_model_glb(&dest, &dest).unwrap();
            }
        }
    }

    #[test]
    fn empty_scene_export_does_not_insert_null_optional_arrays() {
        let dir = TempDir::new();
        let source = dir.0.join("empty.gltf");
        std::fs::write(&source, br#"{"asset":{"version":"2.0"}}"#).unwrap();
        let dest = dir.0.join("empty.glb");
        export_model_glb(&source, &dest).unwrap();
        let bytes = std::fs::read(dest).unwrap();
        gltf::Gltf::from_slice(&bytes).unwrap();
        let glb = Glb::from_slice(&bytes).unwrap();
        let output: Value = serde_json::from_slice(&glb.json).unwrap();
        for field in ["images", "bufferViews", "buffers"] {
            assert!(output.get(field).is_none());
        }
    }

    #[test]
    fn failed_encoding_does_not_modify_existing_destination() {
        let dir = TempDir::new();
        let source = dir.0.join("source.gltf");
        let dest = dir.0.join("existing.glb");
        let original = b"existing destination must survive failed conversion";
        std::fs::write(&dest, original).unwrap();
        for input in [
            b"invalid glTF JSON".as_slice(),
            br#"{"asset":{"version":"2.0"},"buffers":[{"uri":"missing.bin","byteLength":4}]}"#
                .as_slice(),
        ] {
            std::fs::write(&source, input).unwrap();
            assert!(export_model_glb(&source, &dest).is_err());
            assert_eq!(std::fs::read(&dest).unwrap(), original);
        }
    }

    #[cfg(unix)]
    #[test]
    fn export_can_write_selected_file_without_creating_siblings() {
        use std::os::unix::fs::PermissionsExt;

        let dir = TempDir::new();
        let source = dir.0.join("source.gltf");
        std::fs::write(&source, br#"{"asset":{"version":"2.0"}}"#).unwrap();
        let output_dir = dir.0.join("output");
        std::fs::create_dir(&output_dir).unwrap();
        let dest = output_dir.join("selected.glb");
        std::fs::write(&dest, b"old output").unwrap();
        let original_permissions = std::fs::metadata(&output_dir).unwrap().permissions();
        std::fs::set_permissions(&output_dir, std::fs::Permissions::from_mode(0o555)).unwrap();
        // This checks destination-only filesystem access, not macOS Powerbox itself.
        let sibling_write = std::fs::write(output_dir.join("unselected.glb"), b"not selected");
        let exported = export_model_glb(&source, &dest);
        std::fs::set_permissions(&output_dir, original_permissions).unwrap();
        if sibling_write.is_ok() {
            std::fs::remove_file(output_dir.join("unselected.glb")).unwrap();
            eprintln!("SKIP destination-only permission scenario: this environment can create siblings despite directory mode 0555 (for example, when running as root); permission restrictions were not verified.");
            return;
        }
        exported.unwrap();
        assert!(cache::valid_glb(&dest));
        assert_eq!(std::fs::read_dir(&output_dir).unwrap().count(), 1);
    }

    // Required meshopt/BasisU extensions are not supported by gltf-rs validation.
    // Their opaque payload preservation is checked separately from standard GLBs.
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
        assert!(output["buffers"]
            .as_array()
            .unwrap()
            .iter()
            .all(|buffer| buffer.get("uri").is_none()));
        assert_eq!(&glb.bin.unwrap()[8..8 + texture.len()], texture);
        // The exported model must remain usable after all original sidecars disappear.
        for name in ["first.bin", "second buffer.bin", "texture.ktx2"] {
            std::fs::remove_file(dir.0.join(name)).unwrap();
        }
        // Exporting over the source itself must not truncate it.
        export_model_glb(&dest, &dest).unwrap();
        assert!(cache::valid_glb(&dest));
    }
}
