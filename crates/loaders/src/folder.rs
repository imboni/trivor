use std::path::{Path, PathBuf};

use trivor_core::ModelListEntry;

use crate::LoadError;

const MODEL_EXT: &[&str] = &["glb", "gltf"];
const MAX_DEPTH: u8 = 4;

fn is_model_file(path: &Path) -> Option<String> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    MODEL_EXT.contains(&ext.as_str()).then_some(ext)
}

fn push_file(path: PathBuf, out: &mut Vec<ModelListEntry>) {
    let Some(format) = is_model_file(&path) else {
        return;
    };
    let file_size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("model")
        .to_string();
    let path = path
        .canonicalize()
        .unwrap_or(path);
    out.push(ModelListEntry {
        path: path.to_string_lossy().into_owned(),
        name,
        format,
        file_size,
    });
}

fn scan_dir(dir: &Path, depth: u8, out: &mut Vec<ModelListEntry>) {
    if depth > MAX_DEPTH {
        return;
    }
    let Ok(read_dir) = std::fs::read_dir(dir) else {
        return;
    };

    for entry in read_dir.flatten() {
        let path = entry.path();
        if path.is_dir() {
            scan_dir(&path, depth + 1, out);
        } else {
            push_file(path, out);
        }
    }
}

/// List glTF / GLB files under `dir` (recursive, bounded depth).
pub fn list_models_in_folder(dir: &Path) -> Result<Vec<ModelListEntry>, LoadError> {
    if !dir.is_dir() {
        return Err(LoadError::Io {
            path: dir.to_path_buf(),
            message: "not a directory".into(),
        });
    }
    let mut items = Vec::new();
    scan_dir(dir, 0, &mut items);
    Ok(items)
}
