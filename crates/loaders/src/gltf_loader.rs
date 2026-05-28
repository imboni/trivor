use std::collections::HashMap;
use std::path::Path;

use glam::{Mat4, Quat, Vec3, Vec4};
use gltf::image::Source;
use gltf::mesh::util::ReadIndices;
use gltf::scene::Transform;
use gltf::Document;
use trivor_core::{
    BoundingBox, CpuMesh, DrawBatch, LoadedScene, MaterialData, MaterialSummary, MeshData,
    ModelStats, SceneSummary, TextureImage,
};

use crate::LoadError;

pub type ProgressFn<'a> = dyn Fn(u8) + Send + Sync + 'a;

const DEFAULT_COLOR: [f32; 4] = [0.82, 0.84, 0.88, 1.0];

pub fn load_gltf(path: &Path) -> Result<LoadedScene, LoadError> {
    load_gltf_with_progress(path, None)
}

/// Fast metadata pass for the inspector (no mesh upload to GPU / CPU buffers).
pub fn inspect_gltf_summary(
    path: &Path,
    progress: Option<&ProgressFn<'_>>,
) -> Result<SceneSummary, LoadError> {
    let report = |p: u8| {
        if let Some(f) = progress {
            f(p.min(100));
        }
    };

    report(0);
    let path = path
        .canonicalize()
        .map_err(|e| LoadError::Io {
            path: path.to_path_buf(),
            message: e.to_string(),
        })?;

    let file_size = std::fs::metadata(&path)
        .map_err(|e| LoadError::Io {
            path: path.clone(),
            message: e.to_string(),
        })?
        .len();

    report(18);
    // Metadata only — do not decode mesh buffers (model-viewer loads the file).
    let gltf = gltf::Gltf::open(&path).map_err(|e| LoadError::Parse {
        path: path.clone(),
        message: e.to_string(),
    })?;

    report(55);

    let mut vertex_count = 0u64;
    let mut triangle_count = 0u64;
    let mut bounds_min = Vec3::splat(f32::INFINITY);
    let mut bounds_max = Vec3::splat(f32::NEG_INFINITY);
    let mut has_bounds = false;

    for mesh in gltf.meshes() {
        for prim in mesh.primitives() {
            if let Some(indices) = prim.indices() {
                triangle_count += indices.count() as u64 / 3;
            } else if let Some((_, accessor)) = prim
                .attributes()
                .find(|(s, _)| *s == gltf::Semantic::Positions)
            {
                triangle_count += accessor.count() as u64 / 3;
            }

            for (semantic, accessor) in prim.attributes() {
                if semantic != gltf::Semantic::Positions {
                    continue;
                }
                vertex_count += accessor.count() as u64;
                if let (Some(min), Some(max)) = (accessor.min(), accessor.max()) {
                    if let (Some(mn), Some(mx)) = (json_vec3(&min), json_vec3(&max)) {
                        bounds_min = bounds_min.min(mn);
                        bounds_max = bounds_max.max(mx);
                        has_bounds = true;
                    }
                }
            }
        }
    }

    let bounds_size = if has_bounds {
        bounds_max - bounds_min
    } else {
        Vec3::ZERO
    };

    let materials: Vec<MaterialSummary> = gltf
        .materials()
        .map(|m| {
            let factor = m.pbr_metallic_roughness().base_color_factor();
            MaterialSummary {
                name: m.name().unwrap_or("material").to_string(),
                base_color: [factor[0], factor[1], factor[2], factor[3]],
            }
        })
        .collect();

    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("model")
        .to_string();

    report(100);

    Ok(SceneSummary {
        name,
        path: path.display().to_string(),
        format: path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("gltf")
            .to_ascii_lowercase(),
        file_size,
        mesh_count: gltf.meshes().len() as u32,
        material_count: materials.len() as u32,
        vertex_count,
        triangle_count,
        bounds_w: bounds_size.x,
        bounds_h: bounds_size.y,
        bounds_d: bounds_size.z,
        materials,
    })
}

fn json_vec3(value: &gltf::json::Value) -> Option<Vec3> {
    let arr = value.as_array()?;
    if arr.len() < 3 {
        return None;
    }
    Some(Vec3::new(
        arr[0].as_f64()? as f32,
        arr[1].as_f64()? as f32,
        arr[2].as_f64()? as f32,
    ))
}

pub fn load_gltf_with_progress(
    path: &Path,
    progress: Option<&ProgressFn<'_>>,
) -> Result<LoadedScene, LoadError> {
    let report = |p: u8| {
        if let Some(f) = progress {
            f(p.min(100));
        }
    };

    report(2);
    let path = path
        .canonicalize()
        .map_err(|e| LoadError::Io {
            path: path.to_path_buf(),
            message: e.to_string(),
        })?;

    let file_size = std::fs::metadata(&path)
        .map_err(|e| LoadError::Io {
            path: path.clone(),
            message: e.to_string(),
        })?
        .len();

    report(10);
    let (document, buffers, images) = gltf::import(&path).map_err(|e| LoadError::Parse {
        path: path.clone(),
        message: e.to_string(),
    })?;

    report(35);
    let mut positions: Vec<[f32; 3]> = Vec::new();
    let mut normals: Vec<[f32; 3]> = Vec::new();
    let mut uvs: Vec<[f32; 2]> = Vec::new();
    let mut colors: Vec<[f32; 4]> = Vec::new();
    let mut indices: Vec<u32> = Vec::new();
    let mut mesh_infos: Vec<MeshData> = Vec::new();
    let mut draw_batches: Vec<DrawBatch> = Vec::new();
    let mut textures: Vec<TextureImage> = Vec::new();
    let mut texture_cache: HashMap<usize, usize> = HashMap::new();

    let scene = document
        .default_scene()
        .or_else(|| document.scenes().next());

    if let Some(scene) = scene {
        for node in scene.nodes() {
            visit_node(
                node,
                Mat4::IDENTITY,
                &document,
                &buffers,
                &images,
                &path,
                &mut positions,
                &mut normals,
                &mut uvs,
                &mut colors,
                &mut indices,
                &mut mesh_infos,
                &mut draw_batches,
                &mut textures,
                &mut texture_cache,
            )?;
        }
    } else {
        for mesh in document.meshes() {
            push_mesh_primitives(
                mesh,
                Mat4::IDENTITY,
                &document,
                &buffers,
                &images,
                &path,
                &mut positions,
                &mut normals,
                &mut uvs,
                &mut colors,
                &mut indices,
                &mut mesh_infos,
                &mut draw_batches,
                &mut textures,
                &mut texture_cache,
            )?;
        }
    }

    report(75);

    if positions.is_empty() {
        return Err(LoadError::Parse {
            path,
            message: "no mesh geometry found in file".into(),
        });
    }

    if draw_batches.is_empty() {
        draw_batches.push(DrawBatch {
            index_start: 0,
            index_count: indices.len() as u32,
            base_color: DEFAULT_COLOR,
            texture_index: None,
        });
    }

    let bounds = compute_bounds(&positions);
    let bounds_size = bounds.size();
    let vertex_count: u64 = positions.len() as u64;
    let triangle_count: u64 = indices.len() as u64 / 3;

    let materials: Vec<MaterialData> = document
        .materials()
        .map(|m| {
            let factor = m.pbr_metallic_roughness().base_color_factor();
            MaterialData {
                name: m.name().unwrap_or("material").to_string(),
                base_color: [factor[0], factor[1], factor[2], factor[3]],
            }
        })
        .collect();

    report(100);

    let mesh_count = mesh_infos.len() as u32;
    let material_count = materials.len() as u32;

    Ok(LoadedScene {
        source_path: path.display().to_string(),
        format: path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("gltf")
            .to_ascii_lowercase(),
        file_size,
        cpu_mesh: CpuMesh {
            positions,
            normals,
            uvs,
            colors,
            indices,
        },
        draw_batches,
        textures,
        meshes: mesh_infos,
        materials,
        bounds,
        stats: ModelStats {
            mesh_count,
            material_count,
            vertex_count,
            triangle_count,
            bounds_size: [bounds_size.x, bounds_size.y, bounds_size.z],
        },
    })
}

fn visit_node(
    node: gltf::Node,
    parent: Mat4,
    document: &Document,
    buffers: &[gltf::buffer::Data],
    images: &[gltf::image::Data],
    path: &Path,
    positions: &mut Vec<[f32; 3]>,
    normals: &mut Vec<[f32; 3]>,
    uvs: &mut Vec<[f32; 2]>,
    colors: &mut Vec<[f32; 4]>,
    indices: &mut Vec<u32>,
    mesh_infos: &mut Vec<MeshData>,
    draw_batches: &mut Vec<DrawBatch>,
    textures: &mut Vec<TextureImage>,
    texture_cache: &mut HashMap<usize, usize>,
) -> Result<(), LoadError> {
    let world = parent * transform_matrix(node.transform());

    if let Some(mesh) = node.mesh() {
        push_mesh_primitives(
            mesh,
            world,
            document,
            buffers,
            images,
            path,
            positions,
            normals,
            uvs,
            colors,
            indices,
            mesh_infos,
            draw_batches,
            textures,
            texture_cache,
        )?;
    }

    for child in node.children() {
        visit_node(
            child,
            world,
            document,
            buffers,
            images,
            path,
            positions,
            normals,
            uvs,
            colors,
            indices,
            mesh_infos,
            draw_batches,
            textures,
            texture_cache,
        )?;
    }
    Ok(())
}

fn push_mesh_primitives(
    mesh: gltf::Mesh,
    world: Mat4,
    document: &Document,
    buffers: &[gltf::buffer::Data],
    images: &[gltf::image::Data],
    path: &Path,
    positions: &mut Vec<[f32; 3]>,
    normals: &mut Vec<[f32; 3]>,
    uvs: &mut Vec<[f32; 2]>,
    colors: &mut Vec<[f32; 4]>,
    indices: &mut Vec<u32>,
    mesh_infos: &mut Vec<MeshData>,
    draw_batches: &mut Vec<DrawBatch>,
    textures: &mut Vec<TextureImage>,
    texture_cache: &mut HashMap<usize, usize>,
) -> Result<(), LoadError> {
    let normal_matrix = world.inverse().transpose();

    for primitive in mesh.primitives() {
        let reader = primitive.reader(|buffer| {
            buffers
                .get(buffer.index())
                .map(|data| data.0.as_slice())
        });
        let index_start = indices.len() as u32;
        let base = positions.len() as u32;

        let prim_positions: Vec<[f32; 3]> = reader
            .read_positions()
            .ok_or_else(|| LoadError::Parse {
                path: path.to_path_buf(),
                message: "mesh primitive missing POSITION attribute".into(),
            })?
            .map(|p| {
                let v = world * Vec4::new(p[0], p[1], p[2], 1.0);
                [v.x, v.y, v.z]
            })
            .collect();

        let prim_normals: Vec<[f32; 3]> = if let Some(iter) = reader.read_normals() {
            iter.map(|n| {
                let v = normal_matrix
                    .transform_vector3(Vec3::new(n[0], n[1], n[2]))
                    .normalize_or_zero();
                [v.x, v.y, v.z]
            })
            .collect()
        } else {
            vec![[0.0, 1.0, 0.0]; prim_positions.len()]
        };

        let prim_uvs: Vec<[f32; 2]> = if let Some(iter) = reader.read_tex_coords(0) {
            iter.into_f32()
                .map(|uv| [uv[0], 1.0 - uv[1]])
                .collect()
        } else {
            vec![[0.0, 0.0]; prim_positions.len()]
        };

        let material = primitive.material();
        let pbr = material.pbr_metallic_roughness();
        let factor = pbr.base_color_factor();
        let base_color = [factor[0], factor[1], factor[2], factor[3]];
        let prim_colors = vec![base_color; prim_positions.len()];

        let texture_index = pbr
            .base_color_texture()
            .and_then(|info| resolve_texture(document, images, buffers, path, info.texture(), texture_cache, textures));

        let prim_indices: Vec<u32> = match reader.read_indices() {
            Some(ReadIndices::U8(iter)) => iter.map(|i| base + i as u32).collect(),
            Some(ReadIndices::U16(iter)) => iter.map(|i| base + i as u32).collect(),
            Some(ReadIndices::U32(iter)) => iter.map(|i| base + i).collect(),
            None => (0..prim_positions.len() as u32).map(|i| base + i).collect(),
        };

        let index_count = prim_indices.len() as u32;
        draw_batches.push(DrawBatch {
            index_start,
            index_count,
            base_color,
            texture_index,
        });

        let tri_count = index_count as u64 / 3;
        mesh_infos.push(MeshData {
            name: mesh.name().unwrap_or("mesh").to_string(),
            vertex_count: prim_positions.len() as u64,
            triangle_count: tri_count,
        });

        positions.extend(prim_positions);
        normals.extend(prim_normals);
        uvs.extend(prim_uvs);
        colors.extend(prim_colors);
        indices.extend(prim_indices);
    }
    Ok(())
}

fn texture_image_for_view<'a>(
    document: &'a Document,
    texture: gltf::Texture<'a>,
) -> Option<gltf::Image<'a>> {
    if let Some(image) = texture.source() {
        return Some(image);
    }
    let ext = texture.extensions()?;
    let webp = ext.get("EXT_texture_webp")?;
    let idx = webp.get("source")?.as_u64()? as usize;
    document.images().nth(idx)
}

fn resolve_texture(
    document: &Document,
    import_images: &[gltf::image::Data],
    buffers: &[gltf::buffer::Data],
    path: &Path,
    texture: gltf::Texture,
    cache: &mut HashMap<usize, usize>,
    textures: &mut Vec<TextureImage>,
) -> Option<usize> {
    let image = texture_image_for_view(document, texture)?;
    let cache_key = image.index();

    if let Some(&idx) = cache.get(&cache_key) {
        return Some(idx);
    }

    if let Some(data) = import_images.get(cache_key) {
        let rgba = match data.format {
            gltf::image::Format::R8G8B8A8 => data.pixels.clone(),
            gltf::image::Format::R8G8B8 => {
                let mut out = Vec::with_capacity(data.pixels.len() / 3 * 4);
                for chunk in data.pixels.chunks_exact(3) {
                    out.extend_from_slice(&[chunk[0], chunk[1], chunk[2], 255]);
                }
                out
            }
            _ => {
                let bytes = image_bytes_from_source(document, buffers, path, image.source())?;
                return decode_and_cache(bytes, cache_key, cache, textures);
            }
        };
        let idx = textures.len();
        cache.insert(cache_key, idx);
        textures.push(TextureImage {
            width: data.width,
            height: data.height,
            rgba,
        });
        return Some(idx);
    }

    let bytes = image_bytes_from_source(document, buffers, path, image.source())?;
    decode_and_cache(bytes, cache_key, cache, textures)
}

fn image_bytes_from_source(
    document: &Document,
    buffers: &[gltf::buffer::Data],
    path: &Path,
    source: Source,
) -> Option<Vec<u8>> {
    match source {
        Source::View { view, .. } => {
            let buffer_view = document.views().nth(view.index())?;
            let buffer = buffers.get(buffer_view.buffer().index())?;
            let start = buffer_view.offset();
            let end = start + buffer_view.length();
            buffer.0.get(start..end).map(|s| s.to_vec())
        }
        Source::Uri { uri, .. } => {
            let parent = path.parent().unwrap_or(Path::new("."));
            std::fs::read(parent.join(uri)).ok()
        }
    }
}

fn decode_and_cache(
    bytes: Vec<u8>,
    cache_key: usize,
    cache: &mut HashMap<usize, usize>,
    textures: &mut Vec<TextureImage>,
) -> Option<usize> {
    let decoded = image::load_from_memory(&bytes).ok()?;
    let rgba = decoded.to_rgba8();
    let idx = textures.len();
    cache.insert(cache_key, idx);
    textures.push(TextureImage {
        width: rgba.width(),
        height: rgba.height(),
        rgba: rgba.into_raw(),
    });
    Some(idx)
}

fn transform_matrix(transform: Transform) -> Mat4 {
    match transform {
        Transform::Decomposed {
            translation,
            rotation,
            scale,
        } => {
            let t = Mat4::from_translation(Vec3::from(translation));
            let r = Mat4::from_quat(Quat::from_array(rotation));
            let s = Mat4::from_scale(Vec3::from(scale));
            t * r * s
        }
        Transform::Matrix { matrix } => Mat4::from_cols_array_2d(&matrix),
    }
}

fn compute_bounds(positions: &[[f32; 3]]) -> BoundingBox {
    let mut min = Vec3::splat(f32::INFINITY);
    let mut max = Vec3::splat(f32::NEG_INFINITY);
    for p in positions {
        let v = Vec3::from(*p);
        min = min.min(v);
        max = max.max(v);
    }
    BoundingBox { min, max }
}
