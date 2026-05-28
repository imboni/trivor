//! Core domain types for Trivor (极视).

mod mesh;
mod summary;
mod theme;

pub use mesh::{CpuMesh, DrawBatch, TextureImage};
pub use summary::{MaterialSummary, ModelListEntry, SceneSummary};
pub use theme::{Theme, ThemePreference};

use glam::Vec3;
use serde::{Deserialize, Serialize};

/// Application UI phase (drives panel visibility and animations).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum UiPhase {
    #[default]
    Idle,
    Loading,
    Ready,
    Error,
}

/// Easing curves shared by UI (Slint) and 3D camera animations.
pub struct Easing;

impl Easing {
    /// Standard ease-out (Raycast-style exits).
    pub fn ease_out(t: f32) -> f32 {
        let t = t.clamp(0.0, 1.0);
        1.0 - (1.0 - t).powi(3)
    }

    /// Light spring overshoot for panels.
    pub fn spring(t: f32) -> f32 {
        let t = t.clamp(0.0, 1.0);
        let c = 1.70158;
        (t - 1.0).powi(3) * (c * (t - 1.0) + 1.0) + 1.0
    }

    pub fn lerp(a: f32, b: f32, t: f32) -> f32 {
        a + (b - a) * t
    }
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct BoundingBox {
    pub min: Vec3,
    pub max: Vec3,
}

impl BoundingBox {
    pub fn size(&self) -> Vec3 {
        self.max - self.min
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ModelStats {
    pub mesh_count: u32,
    pub material_count: u32,
    pub vertex_count: u64,
    pub triangle_count: u64,
    pub bounds_size: [f32; 3],
}

#[derive(Debug, Clone)]
pub struct MeshData {
    pub name: String,
    pub vertex_count: u64,
    pub triangle_count: u64,
}

#[derive(Debug, Clone)]
pub struct MaterialData {
    pub name: String,
    /// glTF `baseColorFactor` (linear RGBA).
    pub base_color: [f32; 4],
}

/// Unified scene representation consumed by the renderer and info panel.
#[derive(Debug, Clone, Default)]
pub struct LoadedScene {
    pub source_path: String,
    pub format: String,
    pub file_size: u64,
    pub cpu_mesh: CpuMesh,
    pub draw_batches: Vec<DrawBatch>,
    pub textures: Vec<TextureImage>,
    pub meshes: Vec<MeshData>,
    pub materials: Vec<MaterialData>,
    pub bounds: BoundingBox,
    pub stats: ModelStats,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AppConfig {
    pub locale: LocalePreference,
    pub theme: ThemePreference,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LocalePreference {
    #[default]
    System,
    En,
    ZhHans,
}

/// Resolved locale for runtime strings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Locale {
    #[default]
    En,
    ZhHans,
}
