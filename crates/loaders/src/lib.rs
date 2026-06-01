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

fn dir_byte_size(path: &Path) -> Result<u64, LoadError> {
    if !path.is_dir() {
        return Ok(0);
    }
    let mut total = 0u64;
    for entry in std::fs::read_dir(path).map_err(|e| LoadError::Io {
        path: path.to_path_buf(),
        message: e.to_string(),
    })? {
        let entry = entry.map_err(|e| LoadError::Io {
            path: path.to_path_buf(),
            message: e.to_string(),
        })?;
        let meta = entry.metadata().map_err(|e| LoadError::Io {
            path: entry.path(),
            message: e.to_string(),
        })?;
        if meta.is_dir() {
            total = total.saturating_add(dir_byte_size(&entry.path())?);
        } else {
            total = total.saturating_add(meta.len());
        }
    }
    Ok(total)
}

/// Total on-disk size of generated viewer previews and repacked GLBs.
pub fn viewer_cache_byte_size() -> Result<u64, LoadError> {
    dir_byte_size(&viewer_cache_dir())
}

/// Remove all cached viewer assets (previews and repacked GLBs).
pub fn clear_viewer_cache() -> Result<u64, LoadError> {
    let dir = viewer_cache_dir();
    let bytes = dir_byte_size(&dir)?;
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| LoadError::Io {
            path: dir.clone(),
            message: e.to_string(),
        })?;
    }
    std::fs::create_dir_all(&dir).map_err(|e| LoadError::Io {
        path: dir,
        message: e.to_string(),
    })?;
    Ok(bytes)
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
