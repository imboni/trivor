//! Model loaders for Trivor (极视).

mod folder;
mod gltf_inspect;
mod gltf_loader;
mod gltf_optimize;
mod gltf_pack;
mod limits;

use std::path::{Path, PathBuf};
use std::sync::Mutex;

static VIEWER_CACHE_DIR: Mutex<Option<PathBuf>> = Mutex::new(None);

/// App container cache directory (required for Mac App Sandbox).
pub fn set_viewer_cache_dir(path: PathBuf) {
    if let Ok(mut guard) = VIEWER_CACHE_DIR.lock() {
        *guard = Some(path);
    }
}

pub(crate) fn viewer_cache_dir() -> PathBuf {
    VIEWER_CACHE_DIR
        .lock()
        .ok()
        .and_then(|g| g.clone())
        .unwrap_or_else(|| std::env::temp_dir().join("trivor-viewer"))
}

use thiserror::Error;
use trivor_core::SceneSummary;

pub use folder::list_models_in_folder;
pub use gltf_loader::{inspect_gltf_summary, ProgressFn};
pub use gltf_optimize::{
    discover_gltfpack_from_exe_dir, ensure_gltfpack_configured, set_gltfpack_dev_bundle,
    set_gltfpack_path,
};
pub use gltf_pack::resolve_viewer_model;
pub use limits::{format_bytes, file_size};

#[derive(Debug, Error)]
pub enum LoadError {
    #[error("unsupported format: {0}")]
    UnsupportedFormat(String),
    #[error("failed to read {path}: {message}")]
    Io { path: PathBuf, message: String },
    #[error("failed to load {path}: {message}")]
    Parse { path: PathBuf, message: String },
}

/// Load metadata for the inspector (lightweight glTF scan; preview uses model-viewer).
pub fn load_scene_summary(
    path: &Path,
    progress: Option<&ProgressFn<'_>>,
) -> Result<SceneSummary, LoadError> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .ok_or_else(|| LoadError::UnsupportedFormat("unknown".into()))?;

    match ext.as_str() {
        "glb" | "gltf" => inspect_gltf_summary(path, progress),
        other => Err(LoadError::UnsupportedFormat(other.into())),
    }
}
