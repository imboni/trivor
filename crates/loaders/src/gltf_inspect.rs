//! Read glTF/GLB JSON chunk only — no geometry decode.

use std::fs::File;
use std::io::Read;
use std::path::Path;

use glam::{Mat4, Quat, Vec3};
use serde::Deserialize;
use trivor_core::{MaterialSummary, SceneSummary};

use crate::LoadError;

/// On-disk size above which we build a simplified meshopt preview cache.
pub const PREVIEW_OPTIMIZE_BYTES: u64 = 200 * 1024 * 1024;

/// Typical upper bound for reliable direct viewing (matches preview threshold).
pub const VIEWER_STABLE_MAX_BYTES: u64 = PREVIEW_OPTIMIZE_BYTES;
/// Typical upper bound for reliable direct viewing (triangle count from JSON header).
pub const VIEWER_STABLE_MAX_TRIANGLES: u64 = 5_000_000;
/// Above this on-disk size, simplified preview often still fails (textures dominate).
pub const VIEWER_HARD_MAX_BYTES: u64 = 1024 * 1024 * 1024;
/// Above this triangle count, WKWebView often OOMs even after mesh simplification.
pub const VIEWER_HARD_MAX_TRIANGLES: u64 = 20_000_000;

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
    nodes: Vec<GltfNode>,
    #[serde(default)]
    scenes: Vec<GltfScene>,
    scene: Option<usize>,
    #[serde(default)]
    meshes: Vec<GltfMesh>,
    #[serde(default)]
    accessors: Vec<GltfAccessor>,
    #[serde(default)]
    buffers: Vec<GltfBuffer>,
    #[serde(default)]
    materials: Vec<GltfMaterial>,
    #[serde(default, rename = "extensionsUsed")]
    extensions_used: Vec<String>,
    #[serde(default, rename = "extensionsRequired")]
    extensions_required: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct GltfNode {
    mesh: Option<usize>,
    #[serde(default)]
    children: Vec<usize>,
    matrix: Option<[f32; 16]>,
    translation: Option<[f32; 3]>,
    rotation: Option<[f32; 4]>,
    scale: Option<[f32; 3]>,
}

#[derive(Debug, Deserialize)]
struct GltfScene {
    #[serde(default)]
    nodes: Vec<usize>,
}

#[derive(Debug, Deserialize)]
struct GltfMesh {
    #[serde(default)]
    primitives: Vec<GltfPrimitive>,
}

#[derive(Debug, Deserialize)]
struct GltfPrimitive {
    mode: Option<u32>,
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
    #[serde(default, rename = "componentType")]
    component_type: u32,
    #[serde(default)]
    normalized: bool,
    #[serde(default)]
    count: u64,
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

#[derive(Debug, Deserialize)]
#[allow(non_snake_case)]
struct GltfPbr {
    #[serde(default = "default_base_color")]
    baseColorFactor: [f32; 4],
}

fn default_base_color() -> [f32; 4] {
    [1.0; 4]
}

impl Default for GltfPbr {
    fn default() -> Self {
        Self {
            baseColorFactor: default_base_color(),
        }
    }
}

pub(crate) fn read_gltf_json_bytes(path: &Path) -> Result<Vec<u8>, LoadError> {
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
    if &header[0..4] != b"glTF" || u32::from_le_bytes(header[4..8].try_into().unwrap()) != 2 {
        return Err(LoadError::Parse {
            path: path.to_path_buf(),
            message: "not a GLB file".into(),
        });
    }
    let mut chunk_len_buf = [0u8; 8];
    file.read_exact(&mut chunk_len_buf)
        .map_err(|e| LoadError::Io {
            path: path.to_path_buf(),
            message: e.to_string(),
        })?;
    let json_len = u32::from_le_bytes(chunk_len_buf[0..4].try_into().unwrap()) as u64;
    if &chunk_len_buf[4..8] != b"JSON" || json_len > 32 * 1024 * 1024 {
        return Err(LoadError::Parse {
            path: path.to_path_buf(),
            message: "GLB JSON chunk too large to inspect".into(),
        });
    }
    let mut json_bytes = vec![0u8; json_len as usize];
    file.read_exact(&mut json_bytes)
        .map_err(|e| LoadError::Io {
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
    doc.meshes
        .iter()
        .flat_map(|mesh| &mesh.primitives)
        .map(|prim| {
            let count = prim
                .indices
                .and_then(|index| doc.accessors.get(index))
                .or_else(|| {
                    prim.attributes
                        .as_ref()
                        .and_then(|attrs| attrs.POSITION)
                        .and_then(|index| doc.accessors.get(index))
                })
                .map(|accessor| accessor.count)
                .unwrap_or(0);
            match prim.mode.unwrap_or(4) {
                4 => count / 3,
                5 | 6 => count.saturating_sub(2),
                _ => 0,
            }
        })
        .sum()
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
    let mut min = Vec3::splat(f32::INFINITY);
    let mut max = Vec3::splat(f32::NEG_INFINITY);
    let mut add_mesh = |index: usize, transform: Mat4| {
        let Some(mesh) = doc.meshes.get(index) else {
            return;
        };
        for prim in &mesh.primitives {
            let Some(accessor) = prim
                .attributes
                .as_ref()
                .and_then(|attrs| attrs.POSITION)
                .and_then(|index| doc.accessors.get(index))
            else {
                continue;
            };
            if accessor.min.len() < 3 || accessor.max.len() < 3 {
                continue;
            }
            for corner in 0..8 {
                let axis = |index| {
                    let value = if corner & (1 << index) == 0 {
                        accessor.min[index] as f32
                    } else {
                        accessor.max[index] as f32
                    };
                    if !accessor.normalized {
                        return value;
                    }
                    match accessor.component_type {
                        5120 => (value / 127.0).max(-1.0),
                        5121 => value / 255.0,
                        5122 => (value / 32767.0).max(-1.0),
                        5123 => value / 65535.0,
                        _ => value,
                    }
                };
                let point = transform.transform_point3(Vec3::new(axis(0), axis(1), axis(2)));
                if point.is_finite() {
                    min = min.min(point);
                    max = max.max(point);
                }
            }
        }
    };
    if doc.nodes.is_empty() {
        for index in 0..doc.meshes.len() {
            add_mesh(index, Mat4::IDENTITY);
        }
    } else {
        let roots = if let Some(scene) = doc.scenes.get(doc.scene.unwrap_or(0)) {
            scene.nodes.clone()
        } else {
            let children: std::collections::HashSet<usize> = doc
                .nodes
                .iter()
                .flat_map(|node| node.children.iter().copied())
                .collect();
            (0..doc.nodes.len())
                .filter(|index| !children.contains(index))
                .collect()
        };
        let mut stack: Vec<_> = roots
            .into_iter()
            .map(|index| (index, Mat4::IDENTITY))
            .collect();
        let mut visited = std::collections::HashSet::new();
        while let Some((index, parent)) = stack.pop() {
            if !visited.insert(index) {
                continue;
            }
            let Some(node) = doc.nodes.get(index) else {
                continue;
            };
            let local = node
                .matrix
                .map(|m| Mat4::from_cols_array(&m))
                .unwrap_or_else(|| {
                    Mat4::from_scale_rotation_translation(
                        Vec3::from_array(node.scale.unwrap_or([1.0; 3])),
                        Quat::from_array(node.rotation.unwrap_or([0.0, 0.0, 0.0, 1.0])),
                        Vec3::from_array(node.translation.unwrap_or([0.0; 3])),
                    )
                });
            let transform = parent * local;
            if let Some(mesh) = node.mesh {
                add_mesh(mesh, transform);
            }
            stack.extend(node.children.iter().map(|index| (*index, transform)));
        }
    }
    if min.is_finite() && max.is_finite() {
        let size = max - min;
        (size.x, size.y, size.z)
    } else {
        (0.0, 0.0, 0.0)
    }
}

/// Metadata for the inspector without decoding geometry buffers (large models).
pub fn inspect_scene_summary_light(path: &Path) -> Result<SceneSummary, LoadError> {
    let path = path.canonicalize().map_err(|e| LoadError::Io {
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
            name: m.name.clone().unwrap_or_else(|| format!("material_{i}")),
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

const VIEWER_COMPRESSED_EXTENSIONS: &[&str] = &[
    "KHR_mesh_quantization",
    "KHR_draco_mesh_compression",
    "EXT_meshopt_compression",
    "KHR_texture_basisu",
];

/// Geometry/texture compression that model-viewer decodes — skip Rust repack/import decode.
pub fn gltf_skips_rust_repack(path: &Path) -> Result<bool, LoadError> {
    let doc = parse_gltf_json(path)?;
    for ext in VIEWER_COMPRESSED_EXTENSIONS {
        if doc.extensions_required.iter().any(|e| e == ext)
            || doc.extensions_used.iter().any(|e| e == ext)
        {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compressed_summary_handles_quantized_transforms_modes_and_default_material() {
        let dir = crate::cache::tests::TempDir::new();
        let source = dir.0.join("compressed.gltf");
        let doc = serde_json::json!({
            "asset": {"version": "2.0"},
            "extensionsRequired": ["EXT_meshopt_compression", "KHR_mesh_quantization"],
            "scenes": [{"nodes": [0]}],
            "nodes": [{"children": [1], "translation": [10,20,30]}, {"mesh": 0, "scale": [0.1,0.2,0.3]}],
            "meshes": [{"primitives": [{"attributes": {"POSITION": 0}, "indices": 1, "mode": 5}, {"attributes": {"POSITION": 0}, "mode": 1}]}],
            "accessors": [{"count":4,"type":"VEC3","min":[0,0,0],"max":[20,30,40]}, {"count":4,"type":"SCALAR"}],
            "materials": [{}, {"pbrMetallicRoughness": {"metallicFactor": 0.5}}]
        });
        std::fs::write(&source, serde_json::to_vec(&doc).unwrap()).unwrap();
        let summary = crate::load_scene_summary(&source, None).unwrap();
        assert_eq!(summary.triangle_count, 2);
        assert_eq!(
            (summary.bounds_w, summary.bounds_h, summary.bounds_d),
            (2.0, 6.0, 12.0)
        );
        assert!(summary
            .materials
            .iter()
            .all(|material| material.base_color == [1.0; 4]));
    }

    #[test]
    fn quantized_positions_apply_accessor_normalization_before_node_scale() {
        let dir = crate::cache::tests::TempDir::new();
        let source = dir.0.join("normalized.gltf");
        let doc = serde_json::json!({
            "asset": {"version": "2.0"},
            "extensionsRequired": ["KHR_mesh_quantization"],
            "nodes": [{"mesh": 0, "scale": [2, 3, 4]}],
            "meshes": [{"primitives": [{"attributes": {"POSITION": 0}}]}],
            "accessors": [{"count":3,"type":"VEC3","componentType":5121,"normalized":true,"min":[0,0,0],"max":[255,255,255]}]
        });
        std::fs::write(&source, serde_json::to_vec(&doc).unwrap()).unwrap();
        let summary = crate::load_scene_summary(&source, None).unwrap();
        assert_eq!(
            (summary.bounds_w, summary.bounds_h, summary.bounds_d),
            (2.0, 3.0, 4.0)
        );
    }

    #[test]
    fn preview_ratio_scales_with_size() {
        assert!(preview_simplify_ratio(3 * 1024 * 1024 * 1024) <= 0.02);
        assert!(preview_simplify_ratio(250 * 1024 * 1024) >= 0.08);
    }
}
