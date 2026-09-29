//! Cache identity includes source location and referenced assets; writes are published atomically.

use std::collections::{hash_map::DefaultHasher, BTreeSet};
use std::hash::{Hash, Hasher};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::UNIX_EPOCH;

use crate::asset_uri::local_asset_path;
use crate::LoadError;

static TEMP_ID: AtomicU64 = AtomicU64::new(0);

fn io_error(path: &Path, err: std::io::Error) -> LoadError {
    LoadError::Io {
        path: path.to_path_buf(),
        message: err.to_string(),
    }
}

fn obj_dependencies(source: &Path, paths: &mut BTreeSet<PathBuf>) -> Result<(), LoadError> {
    let file = std::fs::File::open(source).map_err(|e| io_error(source, e))?;
    for line in BufReader::new(file).lines() {
        let line = line.map_err(|e| io_error(source, e))?;
        let mut parts = line.trim_start().splitn(2, char::is_whitespace);
        if parts.next() != Some("mtllib") {
            continue;
        }
        let rest = parts.next().unwrap_or("");
        let rest = rest.split('#').next().unwrap_or("").trim();
        let base = source.parent().unwrap_or_else(|| Path::new("."));
        // A single library may contain spaces; otherwise OBJ permits multiple libraries.
        let whole = base.join(rest.trim_matches('"'));
        let libraries = if whole.is_file() {
            vec![whole]
        } else {
            rest.split_whitespace()
                .map(|name| base.join(name.trim_matches('"')))
                .collect()
        };
        for library in libraries {
            paths.insert(library.clone());
            let Ok(file) = std::fs::File::open(&library) else {
                continue;
            };
            for line in BufReader::new(file).lines() {
                let line = line.map_err(|e| io_error(&library, e))?;
                let mut parts = line.trim().splitn(2, char::is_whitespace);
                let directive = parts.next().unwrap_or("");
                if !directive.starts_with("map_")
                    && !matches!(directive, "bump" | "disp" | "decal" | "norm" | "refl")
                {
                    continue;
                }
                let value = parts
                    .next()
                    .unwrap_or("")
                    .split('#')
                    .next()
                    .unwrap_or("")
                    .trim();
                let base = library.parent().unwrap_or_else(|| Path::new("."));
                // Options precede the filename. Try suffixes so spaces in texture names work.
                let mut candidates = vec![value];
                candidates.extend(
                    value
                        .char_indices()
                        .filter(|(_, c)| c.is_whitespace())
                        .map(|(i, c)| &value[i + c.len_utf8()..]),
                );
                let path = candidates
                    .iter()
                    .map(|name| base.join(name.trim_matches('"')))
                    .find(|p| p.is_file())
                    .unwrap_or_else(|| base.join(value.split_whitespace().last().unwrap_or("")));
                paths.insert(path);
            }
        }
    }
    Ok(())
}

pub(crate) fn cache_key(source: &Path, tag: &str) -> Result<String, LoadError> {
    let source = source.canonicalize().map_err(|e| io_error(source, e))?;
    let mut paths = BTreeSet::from([source.clone()]);
    match source
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "obj" => obj_dependencies(&source, &mut paths)?,
        "gltf" | "glb" => {
            let bytes = crate::gltf_inspect::read_gltf_json_bytes(&source)?;
            let doc: serde_json::Value = serde_json::from_slice(&bytes)
                .map_err(|e| crate::asset_uri::parse_error(&source, e.to_string()))?;
            for key in ["buffers", "images"] {
                for entry in doc[key].as_array().into_iter().flatten() {
                    if let Some(uri) = entry["uri"]
                        .as_str()
                        .filter(|uri| !uri.starts_with("data:"))
                    {
                        paths.insert(local_asset_path(&source, uri)?);
                    }
                }
            }
        }
        _ => {}
    }
    let mut hasher = DefaultHasher::new();
    tag.hash(&mut hasher);
    for path in paths {
        path.hash(&mut hasher);
        match std::fs::metadata(&path) {
            Ok(meta) => {
                meta.len().hash(&mut hasher);
                meta.modified()
                    .ok()
                    .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_nanos())
                    .hash(&mut hasher);
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => false.hash(&mut hasher),
            Err(err) => return Err(io_error(&path, err)),
        }
    }
    Ok(format!("{tag}-{:016x}", hasher.finish()))
}

pub(crate) fn valid_glb(path: &Path) -> bool {
    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    let Ok(meta) = file.metadata() else {
        return false;
    };
    let mut header = [0u8; 12];
    file.read_exact(&mut header).is_ok()
        && &header[..4] == b"glTF"
        && u32::from_le_bytes(header[4..8].try_into().unwrap()) == 2
        && u32::from_le_bytes(header[8..12].try_into().unwrap()) as u64 == meta.len()
        && meta.len() >= 20
}

pub(crate) fn write_atomic(
    dest: &Path,
    write: impl FnOnce(&Path) -> Result<(), LoadError>,
) -> Result<(), LoadError> {
    let parent = dest.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent).map_err(|e| io_error(parent, e))?;
    let temp = parent.join(format!(
        ".trivor-{}-{}.glb",
        std::process::id(),
        TEMP_ID.fetch_add(1, Ordering::Relaxed)
    ));
    let result =
        write(&temp).and_then(|()| std::fs::rename(&temp, dest).map_err(|e| io_error(dest, e)));
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) struct TempDir(pub PathBuf);
    impl TempDir {
        pub(crate) fn new() -> Self {
            let dir = std::env::temp_dir().join(format!(
                "trivor-tests-{}-{}",
                std::process::id(),
                TEMP_ID.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn imported_cache_separates_locations_and_tracks_materials_and_textures() {
        let a = TempDir::new();
        let b = TempDir::new();
        for dir in [&a.0, &b.0] {
            std::fs::write(dir.join("mesh.obj"), "mtllib material.mtl\nv 0 0 0\n").unwrap();
            std::fs::write(
                dir.join("material.mtl"),
                "newmtl A\nmap_Kd -s 1 1 1 texture with spaces.png\n",
            )
            .unwrap();
            std::fs::write(dir.join("texture with spaces.png"), b"first").unwrap();
        }
        let modified = UNIX_EPOCH + std::time::Duration::new(1_700_000_000, 123_000_000);
        for dir in [&a.0, &b.0] {
            for name in ["mesh.obj", "material.mtl", "texture with spaces.png"] {
                std::fs::File::options()
                    .write(true)
                    .open(dir.join(name))
                    .unwrap()
                    .set_times(std::fs::FileTimes::new().set_modified(modified))
                    .unwrap();
            }
        }
        let key = || cache_key(&a.0.join("mesh.obj"), "obj-v2").unwrap();
        let original = key();
        assert_ne!(
            original,
            cache_key(&b.0.join("mesh.obj"), "obj-v2").unwrap()
        );
        std::fs::write(a.0.join("texture with spaces.png"), b"different texture").unwrap();
        let texture_change = key();
        assert_ne!(original, texture_change);
        std::fs::write(a.0.join("material.mtl"), "newmtl Other\n").unwrap();
        assert_ne!(texture_change, key());
    }
}
