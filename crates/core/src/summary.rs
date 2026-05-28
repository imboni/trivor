//! Serializable model metadata for the UI layer.

use serde::{Deserialize, Serialize};

use crate::LoadedScene;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MaterialSummary {
    pub name: String,
    pub base_color: [f32; 4],
}

/// Lightweight entry for folder sidebar (no glTF parse).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelListEntry {
    pub path: String,
    pub name: String,
    pub format: String,
    pub file_size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SceneSummary {
    pub name: String,
    pub path: String,
    pub format: String,
    pub file_size: u64,
    pub mesh_count: u32,
    pub material_count: u32,
    pub vertex_count: u64,
    pub triangle_count: u64,
    pub bounds_w: f32,
    pub bounds_h: f32,
    pub bounds_d: f32,
    pub materials: Vec<MaterialSummary>,
}

impl SceneSummary {
    pub fn from_scene(scene: &LoadedScene) -> Self {
        let name = std::path::Path::new(&scene.source_path)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("model")
            .to_string();

        let materials = scene
            .materials
            .iter()
            .map(|m| MaterialSummary {
                name: m.name.clone(),
                base_color: m.base_color,
            })
            .collect();

        Self {
            name,
            path: scene.source_path.clone(),
            format: scene.format.clone(),
            file_size: scene.file_size,
            mesh_count: scene.stats.mesh_count,
            material_count: scene.stats.material_count,
            vertex_count: scene.stats.vertex_count,
            triangle_count: scene.stats.triangle_count,
            bounds_w: scene.stats.bounds_size[0],
            bounds_h: scene.stats.bounds_size[1],
            bounds_d: scene.stats.bounds_size[2],
            materials,
        }
    }
}
