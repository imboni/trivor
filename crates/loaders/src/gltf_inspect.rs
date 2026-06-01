//! Read glTF/GLB JSON chunk only — no geometry decode.

use std::fs::File;
use std::io::Read;
use std::path::Path;

use glam::Vec3;
use serde::Deserialize;
use trivor_core::{MaterialSummary, SceneSummary};

use crate::LoadError;

/// On-disk size above which we build a simplified meshopt preview cache.
pub const PREVIEW_OPTIMIZE_BYTES: u64 = 200 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct GltfQuickStats {
    pub file_size: u64,
    pub buffer_bytes: u64,
    pub mesh_count: usize,
    pub triangle_count: u64,
}

#[derive(Debug, Deserialize)]
struct GltfJsonChunk {
    #[serde(default)]
    meshes: Vec<GltfMesh>,
    #[serde(default)]
    accessors: Vec<GltfAccessor>,
    #[serde(default)]
    buffers: Vec<GltfBuffer>,
    #[serde(default)]
    materials: Vec<GltfMaterial>,
}

#[derive(Debug, Deserialize)]
struct GltfMesh {
    #[serde(default)]
    primitives: Vec<GltfPrimitive>,
}

#[derive(Debug, Deserialize)]
struct GltfPrimitive {
    attributes: Option<GltfAttributes>,
    indices: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[allow(non_snake_case)]
struct GltfAttributes {
    POSITION: Option<usize>,
}

#[derive(Debug, Deserialize)]
struct GltfAccessor {
    #[serde(default)]
    count: u64,
    #[serde(rename = "type")]
    accessor_type: String,
    #[serde(default)]
    min: Vec<f64>,
    #[serde(default)]
    max: Vec<f64>,
}

#[derive(Debug, Deserialize)]
struct GltfBuffer {
    #[serde(default)]
    #[serde(rename = "byteLength")]
    byte_length: u64,
}

#[derive(Debug, Deserialize)]
#[allow(non_snake_case)]
struct GltfMaterial {
    name: Option<String>,
    #[serde(default)]
    pbrMetallicRoughness: GltfPbr,
}

#[derive(Debug, Default, Deserialize)]
#[allow(non_snake_case)]
struct GltfPbr {
    #[serde(default)]
    baseColorFactor: [f32; 4],
}

fn read_gltf_json_bytes(path: &Path) -> Result<Vec<u8>, LoadError> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    if ext == "gltf" {
        return std::fs::read(path).map_err(|e| LoadError::Io {
            path: path.to_path_buf(),
            message: e.to_string(),
        });
    }

    let mut file = File::open(path).map_err(|e| LoadError::Io {
        path: path.to_path_buf(),
        message: e.to_string(),
    })?;
    let mut header = [0u8; 12];
    file.read_exact(&mut header).map_err(|e| LoadError::Io {
        path: path.to_path_buf(),
        message: e.to_string(),
    })?;
    if &header[0..4] != b"glTF" {
        return Err(LoadError::Parse {
            path: path.to_path_buf(),
            message: "not a GLB file".into(),
        });
    }
    let mut chunk_len_buf = [0u8; 8];
    file.read_exact(&mut chunk_len_buf).map_err(|e| LoadError::Io {
        path: path.to_path_buf(),
        message: e.to_string(),
    })?;
    let json_len = u32::from_le_bytes(chunk_len_buf[0..4].try_into().unwrap()) as u64;
    if json_len > 32 * 1024 * 1024 {
        return Err(LoadError::Parse {
            path: path.to_path_buf(),
            message: "GLB JSON chunk too large to inspect".into(),
        });
    }
    let mut json_bytes = vec![0u8; json_len as usize];
    file.read_exact(&mut json_bytes).map_err(|e| LoadError::Io {
        path: path.to_path_buf(),
        message: e.to_string(),
    })?;
    Ok(json_bytes)
}

fn parse_gltf_json(path: &Path) -> Result<GltfJsonChunk, LoadError> {
    let json_bytes = read_gltf_json_bytes(path)?;
    serde_json::from_slice(&json_bytes).map_err(|e| LoadError::Parse {
        path: path.to_path_buf(),
        message: format!("failed to parse glTF JSON: {e}"),
    })
}

fn triangle_count_from_doc(doc: &GltfJsonChunk) -> u64 {
    let mut total = 0u64;
    for mesh in &doc.meshes {
        for prim in &mesh.primitives {
            if let Some(idx) = prim.indices {
                if let Some(acc) = doc.accessors.get(idx) {
                    total += acc.count / 3;
                    continue;
                }
            }
            if let Some(attrs) = &prim.attributes {
                if let Some(pos) = attrs.POSITION {
                    if let Some(acc) = doc.accessors.get(pos) {
                        total += acc.count / 3;
                    }
                }
            }
        }
    }
    if total == 0 {
        total = doc
            .accessors
            .iter()
            .filter(|a| a.accessor_type == "SCALAR")
            .map(|a| a.count)
            .sum::<u64>()
            / 3;
    }
    total
}

fn vertex_count_from_doc(doc: &GltfJsonChunk) -> u64 {
    let mut total = 0u64;
    for mesh in &doc.meshes {
        for prim in &mesh.primitives {
            if let Some(attrs) = &prim.attributes {
                if let Some(pos) = attrs.POSITION {
                    if let Some(acc) = doc.accessors.get(pos) {
                        total += acc.count;
                    }
                }
            }
        }
    }
    total
}

fn bounds_from_doc(doc: &GltfJsonChunk) -> (f32, f32, f32) {
    let mut bounds_min = Vec3::splat(f32::INFINITY);
    let mut bounds_max = Vec3::splat(f32::NEG_INFINITY);
    let mut has_bounds = false;

    for mesh in &doc.meshes {
        for prim in &mesh.primitives {
            let Some(attrs) = &prim.attributes else { continue };
            let Some(pos_idx) = attrs.POSITION else { continue };
            let Some(acc) = doc.accessors.get(pos_idx) else { continue };
            if acc.min.len() >= 3 && acc.max.len() >= 3 {
                let mn = Vec3::new(acc.min[0] as f32, acc.min[1] as f32, acc.min[2] as f32);
                let mx = Vec3::new(acc.max[0] as f32, acc.max[1] as f32, acc.max[2] as f32);
                bounds_min = bounds_min.min(mn);
                bounds_max = bounds_max.max(mx);
                has_bounds = true;
            }
        }
    }

    if has_bounds {
        let size = bounds_max - bounds_min;
        (size.x, size.y, size.z)
    } else {
        (0.0, 0.0, 0.0)
    }
}

/// Metadata for the inspector without decoding geometry buffers (large models).
pub fn inspect_scene_summary_light(path: &Path) -> Result<SceneSummary, LoadError> {
    let path = path
        .canonicalize()
        .map_err(|e| LoadError::Io {
            path: path.to_path_buf(),
            message: e.to_string(),
        })?;
    let file_size = crate::limits::file_size(&path)?;
    let doc = parse_gltf_json(&path)?;
    let (bounds_w, bounds_h, bounds_d) = bounds_from_doc(&doc);
    let materials: Vec<MaterialSummary> = doc
        .materials
        .iter()
        .enumerate()
        .map(|(i, m)| MaterialSummary {
            name: m
                .name
                .clone()
                .unwrap_or_else(|| format!("material_{i}")),
            base_color: m.pbrMetallicRoughness.baseColorFactor,
        })
        .collect();
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("model")
        .to_string();

    Ok(SceneSummary {
        name,
        path: path.display().to_string(),
        format: path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("gltf")
            .to_ascii_lowercase(),
        file_size,
        mesh_count: doc.meshes.len() as u32,
        material_count: materials.len() as u32,
        vertex_count: vertex_count_from_doc(&doc),
        triangle_count: triangle_count_from_doc(&doc),
        bounds_w,
        bounds_h,
        bounds_d,
        materials,
    })
}

pub fn inspect_gltf_quick(path: &Path) -> Result<GltfQuickStats, LoadError> {
    let file_size = crate::limits::file_size(path)?;
    let doc = parse_gltf_json(path)?;
    let buffer_bytes = doc.buffers.iter().map(|b| b.byte_length).sum();
    Ok(GltfQuickStats {
        file_size,
        mesh_count: doc.meshes.len(),
        buffer_bytes,
        triangle_count: triangle_count_from_doc(&doc),
    })
}

/// `.gltf` JSON + sidecar totals (no geometry decode).
pub fn inspect_gltf_file(path: &Path) -> Result<GltfQuickStats, LoadError> {
    let total_bytes = gltf_sidecar_bytes(path)?;
    let doc = parse_gltf_json(path)?;
    let json_buffer_bytes = doc.buffers.iter().map(|b| b.byte_length).sum::<u64>();
    let buffer_bytes = json_buffer_bytes.max(total_bytes);

    Ok(GltfQuickStats {
        file_size: total_bytes,
        buffer_bytes,
        mesh_count: doc.meshes.len(),
        triangle_count: triangle_count_from_doc(&doc),
    })
}

pub fn needs_preview_optimize(stats: &GltfQuickStats) -> bool {
    stats.file_size >= PREVIEW_OPTIMIZE_BYTES || stats.buffer_bytes >= PREVIEW_OPTIMIZE_BYTES
}

/// Whether inspector metadata can skip full geometry decode.
pub fn needs_lightweight_summary(path: &Path, file_size: u64) -> bool {
    if file_size >= PREVIEW_OPTIMIZE_BYTES {
        return true;
    }
    let Some(ext) = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
    else {
        return false;
    };
    match ext.as_str() {
        "glb" => inspect_gltf_quick(path)
            .ok()
            .is_some_and(|stats| needs_preview_optimize(&stats)),
        "gltf" => inspect_gltf_file(path)
            .ok()
            .is_some_and(|stats| needs_preview_optimize(&stats)),
        _ => false,
    }
}

pub fn preview_simplify_ratio(file_size: u64) -> f32 {
    if file_size >= 2 * 1024 * 1024 * 1024 {
        0.02
    } else if file_size >= 1024 * 1024 * 1024 {
        0.03
    } else if file_size >= 500 * 1024 * 1024 {
        0.05
    } else if file_size >= 200 * 1024 * 1024 {
        0.08
    } else {
        0.1
    }
}

/// `.gltf` sidecar total size (JSON + bin + textures) for repack threshold checks.
pub fn gltf_sidecar_bytes(gltf_path: &Path) -> Result<u64, LoadError> {
    let base = gltf_path.parent().unwrap_or_else(|| Path::new("."));
    let bytes = std::fs::read(gltf_path).map_err(|e| LoadError::Io {
        path: gltf_path.to_path_buf(),
        message: e.to_string(),
    })?;
    let doc: serde_json::Value = serde_json::from_slice(&bytes).map_err(|e| LoadError::Parse {
        path: gltf_path.to_path_buf(),
        message: e.to_string(),
    })?;
    let mut total = gltf_path
        .metadata()
        .map_err(|e| LoadError::Io {
            path: gltf_path.to_path_buf(),
            message: e.to_string(),
        })?
        .len();

    if let Some(buffers) = doc.get("buffers").and_then(|v| v.as_array()) {
        for buffer in buffers {
            if let Some(uri) = buffer.get("uri").and_then(|v| v.as_str()) {
                if uri.starts_with("data:") {
                    continue;
                }
                let sidecar = base.join(uri);
                if sidecar.exists() {
                    total += sidecar.metadata().map(|m| m.len()).unwrap_or(0);
                }
            }
        }
    }
    if let Some(images) = doc.get("images").and_then(|v| v.as_array()) {
        for image in images {
            if let Some(uri) = image.get("uri").and_then(|v| v.as_str()) {
                if uri.starts_with("data:") {
                    continue;
                }
                let sidecar = base.join(uri);
                if sidecar.exists() {
                    total += sidecar.metadata().map(|m| m.len()).unwrap_or(0);
                }
            }
        }
    }
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_ratio_scales_with_size() {
        assert!(preview_simplify_ratio(3 * 1024 * 1024 * 1024) <= 0.02);
        assert!(preview_simplify_ratio(250 * 1024 * 1024) >= 0.08);
    }
}
