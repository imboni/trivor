//! CPU-side mesh data passed from loaders to the renderer.

/// RGBA8 image for PBR base color textures.
#[derive(Debug, Clone)]
pub struct TextureImage {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

/// One draw call range with optional texture.
#[derive(Debug, Clone)]
pub struct DrawBatch {
    pub index_start: u32,
    pub index_count: u32,
    pub base_color: [f32; 4],
    pub texture_index: Option<usize>,
}

#[derive(Debug, Clone, Default)]
pub struct CpuMesh {
    pub positions: Vec<[f32; 3]>,
    pub normals: Vec<[f32; 3]>,
    pub uvs: Vec<[f32; 2]>,
    /// Fallback tint when no texture is bound.
    pub colors: Vec<[f32; 4]>,
    pub indices: Vec<u32>,
}

impl CpuMesh {
    pub fn is_empty(&self) -> bool {
        self.positions.is_empty() || self.indices.is_empty()
    }
}
