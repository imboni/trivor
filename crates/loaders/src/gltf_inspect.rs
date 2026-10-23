//! Read glTF/GLB JSON chunk only — no geometry decode.

use std::collections::BTreeSet;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;

use glam::{Mat4, Quat, Vec3};
use serde::Deserialize;
use trivor_core::{MaterialSummary, SceneSummary};

use crate::LoadError;

/// On-disk size above which we build a simplified meshopt preview cache.
pub const PREVIEW_OPTIMIZE_BYTES: u64 = 200 * 1024 * 1024;

/// Typical upper bound for reliable direct viewing (matches preview threshold).
pub const VIEWER_STABLE_MAX_BYTES: u64 = PREVIEW_OPTIMIZE_BYTES;
/// Typical upper bound for reliable direct viewing (triangle count from JSON header).
pub const VIEWER_STABLE_MAX_TRIANGLES: u64 = 2_000_000;
/// Above this on-disk size, simplified preview often still fails (textures dominate).
pub const VIEWER_HARD_MAX_BYTES: u64 = 1024 * 1024 * 1024;
/// Above this triangle count, WKWebView often OOMs even after mesh simplification.
pub const VIEWER_HARD_MAX_TRIANGLES: u64 = 20_000_000;

#[derive(Debug, Clone)]
pub struct GltfQuickStats {
    pub file_size: u64,
    pub buffer_bytes: u64,
    pub mesh_count: usize,
    pub draw_calls: u64,
    pub instance_count: u64,
    pub triangle_count: u64,
    /// Conservative uncompressed accessor storage (including animation/morph data).
    pub geometry_bytes: u64,
    /// RGBA8 with mipmaps, deliberately independent of compressed file size.
    pub texture_bytes: u64,
    pub image_count: usize,
    pub required_draco: bool,
    pub texture_encoding_failed: bool,
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
    #[serde(default, rename = "bufferViews")]
    buffer_views: Vec<GltfBufferView>,
    #[serde(default)]
    images: Vec<GltfImage>,
    #[serde(default)]
    materials: Vec<GltfMaterial>,
    #[serde(default, rename = "extensionsUsed")]
    extensions_used: Vec<String>,
    #[serde(default, rename = "extensionsRequired")]
    extensions_required: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct GltfNode {
    #[serde(default)]
    extensions: GltfNodeExtensions,
    mesh: Option<usize>,
    #[serde(default)]
    children: Vec<usize>,
    matrix: Option<[f32; 16]>,
    translation: Option<[f32; 3]>,
    rotation: Option<[f32; 4]>,
    scale: Option<[f32; 3]>,
}

#[derive(Debug, Default, Deserialize)]
struct GltfNodeExtensions {
    #[serde(rename = "EXT_mesh_gpu_instancing")]
    instancing: Option<GltfInstancing>,
}
#[derive(Debug, Deserialize)]
struct GltfInstancing {
    #[serde(default)]
    attributes: std::collections::HashMap<String, usize>,
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
    #[serde(default, rename = "type")]
    kind: String,
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
    uri: Option<String>,
    #[serde(default)]
    #[serde(rename = "byteLength")]
    byte_length: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GltfBufferView {
    buffer: usize,
    #[serde(default)]
    byte_offset: u64,
    byte_length: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GltfImage {
    uri: Option<String>,
    buffer_view: Option<usize>,
    #[serde(default)]
    mime_type: String,
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
    crate::gltf_metadata::read(path)
}

fn primitive_triangles(doc: &GltfJsonChunk, prim: &GltfPrimitive) -> u64 {
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
}

fn triangle_count_from_doc(doc: &GltfJsonChunk) -> u64 {
    doc.meshes
        .iter()
        .flat_map(|mesh| &mesh.primitives)
        .fold(0u64, |sum, prim| {
            sum.saturating_add(primitive_triangles(doc, prim))
        })
}

/// Include all visible instances, not only unique meshes/accessors. In particular,
/// thousands of copies of one small part can exceed the draw and face budgets.
fn render_work(doc: &GltfJsonChunk) -> (u64, u64, u64) {
    if doc.nodes.is_empty() {
        return (
            triangle_count_from_doc(doc),
            doc.meshes.iter().map(|m| m.primitives.len() as u64).sum(),
            doc.meshes.len() as u64,
        );
    }
    let mut stack = if let Some(scene) = doc.scenes.get(doc.scene.unwrap_or(0)) {
        scene.nodes.clone()
    } else {
        let children: BTreeSet<usize> = doc
            .nodes
            .iter()
            .flat_map(|n| n.children.iter().copied())
            .collect();
        (0..doc.nodes.len())
            .filter(|i| !children.contains(i))
            .collect()
    };
    let mut visited = BTreeSet::new();
    let (mut triangles, mut draws, mut instances) = (0u64, 0u64, 0u64);
    while let Some(index) = stack.pop() {
        if !visited.insert(index) {
            continue;
        }
        let Some(node) = doc.nodes.get(index) else {
            continue;
        };
        if let Some(mesh) = node.mesh.and_then(|i| doc.meshes.get(i)) {
            let copies = node
                .extensions
                .instancing
                .as_ref()
                .and_then(|instancing| {
                    instancing
                        .attributes
                        .values()
                        .filter_map(|i| doc.accessors.get(*i))
                        .map(|a| a.count)
                        .max()
                })
                .unwrap_or(1);
            let faces = mesh.primitives.iter().fold(0u64, |sum, p| {
                sum.saturating_add(primitive_triangles(doc, p))
            });
            triangles = triangles.saturating_add(faces.saturating_mul(copies));
            draws = draws.saturating_add(mesh.primitives.len() as u64);
            instances = instances.saturating_add(copies);
        }
        stack.extend(&node.children);
    }
    (triangles, draws, instances)
}

fn vertex_count_from_doc(doc: &GltfJsonChunk) -> u64 {
    let mut total = 0u64;
    for mesh in &doc.meshes {
        for prim in &mesh.primitives {
            if let Some(attrs) = &prim.attributes {
                if let Some(pos) = attrs.POSITION {
                    if let Some(acc) = doc.accessors.get(pos) {
                        total = total.saturating_add(acc.count);
                    }
                }
            }
        }
    }
    total
}

fn bounds_from_doc(doc: &GltfJsonChunk) -> (f32, f32, f32) {
    // Instance transforms are in binary accessors. A header-only scan cannot
    // truthfully substitute the untransformed prototype's dimensions.
    if doc
        .nodes
        .iter()
        .any(|node| node.extensions.instancing.is_some())
    {
        return (0.0, 0.0, 0.0);
    }
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
    inspect_scene_summary_light_cancellable(path, &AtomicBool::new(false))
}

pub(crate) fn inspect_scene_summary_light_cancellable(
    path: &Path,
    cancelled: &AtomicBool,
) -> Result<SceneSummary, LoadError> {
    let path = path.canonicalize().map_err(|e| LoadError::Io {
        path: path.to_path_buf(),
        message: e.to_string(),
    })?;
    let file_size = crate::limits::file_size(&path)?;
    let doc: GltfJsonChunk = crate::gltf_metadata::read_cancellable(&path, cancelled)?;
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
    inspect_gltf_file(path)
}

/// Resolve only physical dependencies. Inline payloads are omitted by the metadata
/// reader, so even a multi-gigabyte embedded .gltf never becomes a JSON String.
pub(crate) fn external_paths(path: &Path) -> Result<BTreeSet<PathBuf>, LoadError> {
    external_paths_cancellable(path, &AtomicBool::new(false))
}

pub(crate) fn external_paths_cancellable(
    path: &Path,
    cancelled: &AtomicBool,
) -> Result<BTreeSet<PathBuf>, LoadError> {
    let doc = crate::gltf_metadata::read_cancellable(path, cancelled)?;
    external_paths_from_doc(path, &doc)
}

fn external_paths_from_doc(
    path: &Path,
    doc: &GltfJsonChunk,
) -> Result<BTreeSet<PathBuf>, LoadError> {
    doc.buffers
        .iter()
        .filter_map(|b| b.uri.as_deref())
        .chain(doc.images.iter().filter_map(|i| i.uri.as_deref()))
        .filter(|uri| !uri.starts_with("data:"))
        .map(|uri| crate::asset_uri::local_asset_path(path, uri))
        .collect()
}

fn read_prefix(path: &Path, offset: u64, length: u64) -> Result<Vec<u8>, LoadError> {
    let mut file = File::open(path).map_err(|e| crate::model_assets::io_error(path, e))?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| crate::model_assets::io_error(path, e))?;
    let mut bytes = Vec::new();
    file.take(length.min(64 * 1024))
        .read_to_end(&mut bytes)
        .map_err(|e| crate::model_assets::io_error(path, e))?;
    Ok(bytes)
}

fn image_prefix(path: &Path, doc: &GltfJsonChunk, image: &GltfImage) -> Result<Vec<u8>, LoadError> {
    if let Some(uri) = &image.uri {
        if uri.starts_with("data:") {
            // Metadata retained only a short prefix; truncate base64 to whole groups.
            if let Some((header, body)) =
                uri.split_once(',').filter(|(h, _)| h.ends_with(";base64"))
            {
                // A metadata prefix may end in the middle of a percent escape;
                // unknown dimensions are charged conservatively below.
                return Ok(crate::asset_uri::read_asset(
                    path,
                    &format!("{header},{}", &body[..body.len() / 4 * 4]),
                )
                .unwrap_or_default());
            }
            return Ok(Vec::new());
        }
        return read_prefix(&crate::asset_uri::local_asset_path(path, uri)?, 0, u64::MAX);
    }
    let Some(view) = image.buffer_view.and_then(|i| doc.buffer_views.get(i)) else {
        return Ok(Vec::new());
    };
    let Some(buffer) = doc.buffers.get(view.buffer) else {
        return Ok(Vec::new());
    };
    if let Some(uri) = &buffer.uri {
        if uri.starts_with("data:") {
            return Ok(Vec::new());
        }
        return read_prefix(
            &crate::asset_uri::local_asset_path(path, uri)?,
            view.byte_offset,
            view.byte_length,
        );
    }
    if view.buffer == 0
        && path
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("glb"))
    {
        let header = read_prefix(path, 0, 20)?;
        if header.len() == 20 {
            let bin = 28 + u32::from_le_bytes(header[12..16].try_into().unwrap()) as u64;
            return read_prefix(path, bin.saturating_add(view.byte_offset), view.byte_length);
        }
    }
    Ok(Vec::new())
}

fn image_dimensions(bytes: &[u8], _mime: &str) -> Option<(u32, u32)> {
    if bytes.starts_with(b"\xabKTX 20\xbb\r\n\x1a\n") && bytes.len() >= 44 {
        let u = |offset| u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap());
        // Account for arrays, cubemaps and volumes conservatively in the area.
        let layers = u(32)
            .max(1)
            .saturating_mul(u(36).max(1))
            .saturating_mul(u(28).max(1));
        return Some((u(20), u(24).max(1).saturating_mul(layers)));
    }
    image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .ok()?
        .into_dimensions()
        .ok()
}

pub(crate) fn external_image_decoded_bytes(path: &Path) -> Result<u64, LoadError> {
    let prefix = read_prefix(path, 0, u64::MAX)?;
    Ok(image_dimensions(&prefix, "")
        .map(|(w, h)| (w as u64).saturating_mul(h as u64).saturating_mul(16) / 3)
        .unwrap_or(1024 * 1024 * 1024))
}

pub fn inspect_gltf_file(path: &Path) -> Result<GltfQuickStats, LoadError> {
    inspect_gltf_file_cancellable(path, &AtomicBool::new(false))
}

pub(crate) fn inspect_gltf_file_cancellable(
    path: &Path,
    cancelled: &AtomicBool,
) -> Result<GltfQuickStats, LoadError> {
    let doc: GltfJsonChunk = crate::gltf_metadata::read_cancellable(path, cancelled)?;
    let mut file_size = crate::limits::file_size(path)?;
    for dependency in external_paths_from_doc(path, &doc)? {
        file_size = file_size.saturating_add(crate::limits::file_size(&dependency)?);
    }
    let buffer_bytes = doc
        .buffers
        .iter()
        .fold(0u64, |sum, b| sum.saturating_add(b.byte_length));
    let accessor_bytes = doc.accessors.iter().fold(0u64, |sum, accessor| {
        let components = match accessor.kind.as_str() {
            "SCALAR" => 1,
            "VEC2" => 2,
            "VEC3" => 3,
            "VEC4" | "MAT2" => 4,
            "MAT3" => 9,
            "MAT4" => 16,
            _ => 16,
        };
        sum.saturating_add(accessor.count.saturating_mul(components * 4))
    });
    let image_views: BTreeSet<usize> = doc.images.iter().filter_map(|i| i.buffer_view).collect();
    let view_bytes = doc
        .buffer_views
        .iter()
        .enumerate()
        .filter(|(i, _)| !image_views.contains(i))
        .fold(0u64, |sum, (_, view)| sum.saturating_add(view.byte_length));
    let mut texture_bytes = 0u64;
    for image in &doc.images {
        crate::gltf_optimize::check_cancelled(path, cancelled)?;
        let prefix = image_prefix(path, &doc, image)?;
        let bytes = image_dimensions(&prefix, &image.mime_type)
            .map(|(w, h)| {
                (w as u64)
                    .saturating_mul(h as u64)
                    .saturating_mul(4)
                    .saturating_mul(4)
                    / 3
            })
            // Unknown dimensions must never be treated as a zero-cost texture.
            .unwrap_or(1024 * 1024 * 1024);
        texture_bytes = texture_bytes.saturating_add(bytes);
    }
    let (triangle_count, draw_calls, instance_count) = render_work(&doc);
    Ok(GltfQuickStats {
        file_size,
        buffer_bytes,
        mesh_count: doc.meshes.len(),
        draw_calls,
        instance_count,
        triangle_count,
        geometry_bytes: accessor_bytes.max(view_bytes),
        texture_bytes,
        image_count: doc.images.len(),
        texture_encoding_failed: doc
            .images
            .iter()
            .any(|image| image.uri.as_deref() == Some("data:image/png;base64,ERR/")),
        required_draco: doc
            .extensions_required
            .iter()
            .any(|e| e == "KHR_draco_mesh_compression"),
    })
}

pub fn needs_preview_optimize(stats: &GltfQuickStats) -> bool {
    stats.file_size >= PREVIEW_OPTIMIZE_BYTES
        || stats.buffer_bytes >= PREVIEW_OPTIMIZE_BYTES
        || stats.draw_calls > 512
        || stats.instance_count > 10_000
        || stats.geometry_bytes > 128 * 1024 * 1024
        || stats.texture_bytes > 128 * 1024 * 1024
        || stats.triangle_count > VIEWER_STABLE_MAX_TRIANGLES
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
    fn budgets_count_decoded_accessors_and_mesh_instances_not_only_disk_bytes() {
        let dir = crate::cache::tests::TempDir::new();
        let source = dir.0.join("instances.gltf");
        let mut doc = serde_json::json!({
            "asset": {"version":"2.0"},
            "nodes": (0..513).map(|_| serde_json::json!({"mesh":0})).collect::<Vec<_>>(),
            "meshes": [{"primitives":[{"attributes":{"POSITION":0}}]}],
            "accessors": [{"count":36,"type":"VEC3","componentType":5126}]
        });
        std::fs::write(&source, serde_json::to_vec(&doc).unwrap()).unwrap();
        let stats = inspect_gltf_file(&source).unwrap();
        assert_eq!(stats.triangle_count, 12 * 513);
        assert_eq!(stats.draw_calls, 513);
        assert_eq!(stats.geometry_bytes, 36 * 12);
        assert!(needs_preview_optimize(&stats));
        doc["nodes"] = serde_json::json!([{"mesh":0,"extensions":{"EXT_mesh_gpu_instancing":{"attributes":{"TRANSLATION":1}}}}]);
        doc["accessors"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({"count":100001,"type":"VEC3","componentType":5126}));
        std::fs::write(&source, serde_json::to_vec(&doc).unwrap()).unwrap();
        let stats = inspect_gltf_file(&source).unwrap();
        assert_eq!(stats.draw_calls, 1);
        assert_eq!(stats.instance_count, 100001);
        assert_eq!(stats.triangle_count, 1_200_012);
        assert!(needs_preview_optimize(&stats));
        let summary = inspect_scene_summary_light(&source).unwrap();
        assert_eq!(
            (summary.bounds_w, summary.bounds_h, summary.bounds_d),
            (0.0, 0.0, 0.0)
        );
        doc["nodes"] = serde_json::json!([{"mesh":0}]);
        doc["accessors"][0]["count"] = serde_json::json!(100_000_000);
        std::fs::write(&source, serde_json::to_vec(&doc).unwrap()).unwrap();
        let stats = inspect_gltf_file(&source).unwrap();
        assert!(stats.file_size < 1024);
        assert!(stats.geometry_bytes > 1024 * 1024 * 1024);
        assert!(needs_preview_optimize(&stats));
    }

    #[test]
    fn encoded_dependency_paths_and_texture_dimensions_use_headers() {
        let dir = crate::cache::tests::TempDir::new();
        let source = dir.0.join("textured.gltf");
        let texture = dir.0.join("纹理 test.png");
        image::RgbaImage::from_pixel(256, 128, image::Rgba([255, 20, 40, 255]))
            .save(&texture)
            .unwrap();
        let bin = dir.0.join("geo metry.bin");
        std::fs::write(&bin, [0; 1024]).unwrap();
        let doc = serde_json::json!({
            "asset":{"version":"2.0"},
            "buffers":[{"uri":"geo%20metry.bin","byteLength":1024}],
            "images":[{"uri":"%E7%BA%B9%E7%90%86%20test.png"}]
        });
        std::fs::write(&source, serde_json::to_vec(&doc).unwrap()).unwrap();
        let stats = inspect_gltf_file(&source).unwrap();
        assert_eq!(
            stats.file_size,
            source.metadata().unwrap().len() + texture.metadata().unwrap().len() + 1024
        );
        assert_eq!(stats.texture_bytes, 256 * 128 * 16 / 3);
        assert_eq!(external_paths(&source).unwrap().len(), 2);
        assert!(!needs_preview_optimize(&stats));
    }

    #[test]
    fn unknown_texture_size_is_conservative_and_ktx_layers_are_counted() {
        assert_eq!(image_dimensions(&[], "image/unknown"), None);
        let mut bytes = vec![0; 44];
        bytes[..12].copy_from_slice(b"\xabKTX 20\xbb\r\n\x1a\n");
        bytes[20..24].copy_from_slice(&1024u32.to_le_bytes());
        bytes[24..28].copy_from_slice(&512u32.to_le_bytes());
        bytes[32..36].copy_from_slice(&3u32.to_le_bytes());
        bytes[36..40].copy_from_slice(&6u32.to_le_bytes());
        assert_eq!(
            image_dimensions(&bytes, "image/ktx2"),
            Some((1024, 512 * 18))
        );
    }
}
