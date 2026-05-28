//! Model loaders for Trivor (极视).

mod folder;
mod gltf_loader;
mod gltf_pack;

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
use trivor_core::{LoadedScene, SceneSummary};

pub use folder::list_models_in_folder;
pub use gltf_pack::resolve_viewer_model;

pub use gltf_loader::{load_gltf, load_gltf_with_progress, ProgressFn};

#[derive(Debug, Error)]
pub enum LoadError {
    #[error("unsupported format: {0}")]
    UnsupportedFormat(String),
    #[error("failed to read {path}: {message}")]
    Io { path: PathBuf, message: String },
    #[error("failed to load {path}: {message}")]
    Parse { path: PathBuf, message: String },
}

/// Load a model file (M1: glTF / GLB).
pub fn load_model(path: &Path) -> Result<LoadedScene, LoadError> {
    load_model_with_progress(path, None)
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
        "glb" | "gltf" => gltf_loader::inspect_gltf_summary(path, progress),
        "obj" | "stl" => Err(LoadError::Parse {
            path: path.to_path_buf(),
            message: format!("`.{ext}` support coming in M2"),
        }),
        other => Err(LoadError::UnsupportedFormat(other.into())),
    }
}

/// Load with optional progress callback (`0..=100`).
pub fn load_model_with_progress(
    path: &Path,
    progress: Option<&ProgressFn<'_>>,
) -> Result<LoadedScene, LoadError> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .ok_or_else(|| LoadError::UnsupportedFormat("unknown".into()))?;

    match ext.as_str() {
        "glb" | "gltf" => load_gltf_with_progress(path, progress),
        "obj" | "stl" => Err(LoadError::Parse {
            path: path.to_path_buf(),
            message: format!("`.{ext}` support coming in M2"),
        }),
        other => Err(LoadError::UnsupportedFormat(other.into())),
    }
}
