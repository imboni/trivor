use std::path::Path;

use glam::Vec3;
use trivor_core::{MaterialSummary, SceneSummary};

use crate::gltf_inspect::{inspect_scene_summary_light, needs_lightweight_summary};
use crate::LoadError;

pub type ProgressFn<'a> = dyn Fn(u8) + Send + Sync + 'a;

/// Fast metadata pass for the inspector (model-viewer loads geometry separately).
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

    let file_size = crate::limits::file_size(&path)?;

    if needs_lightweight_summary(&path, file_size) {
        report(40);
        let summary = inspect_scene_summary_light(&path)?;
        report(100);
        return Ok(summary);
    }

    report(18);
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
