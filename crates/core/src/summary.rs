//! Serializable model metadata for the UI layer.

use serde::{Deserialize, Serialize};

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
