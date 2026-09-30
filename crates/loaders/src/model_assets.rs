//! Check actual file-read access before a sandboxed import starts.

use std::fs::File;
use std::path::Path;

use crate::LoadError;

pub(crate) fn io_error(path: &Path, error: std::io::Error) -> LoadError {
    if error.kind() == std::io::ErrorKind::PermissionDenied
        || (cfg!(unix) && matches!(error.raw_os_error(), Some(1 | 13)))
    {
        LoadError::PermissionDenied {
            path: path.to_path_buf(),
        }
    } else {
        LoadError::Io {
            path: path.to_path_buf(),
            message: error.to_string(),
        }
    }
}

/// Opens the model and every local material, texture and buffer dependency.
/// Metadata alone is insufficient: macOS can allow stat() but deny File::open().
pub fn ensure_model_assets_readable(source: &Path) -> Result<(), LoadError> {
    File::open(source).map_err(|error| io_error(source, error))?;
    for path in crate::cache::referenced_paths(source)? {
        File::open(&path).map_err(|error| io_error(&path, error))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cache::tests::TempDir;

    #[test]
    fn permission_errors_keep_the_denied_asset_path() {
        let path = Path::new("/models/materials/color.mtl");
        for code in [1, 13] {
            assert!(matches!(
                io_error(path, std::io::Error::from_raw_os_error(code)),
                LoadError::PermissionDenied { path: denied } if denied == path
            ));
        }
        assert!(matches!(
            io_error(path, std::io::Error::from(std::io::ErrorKind::NotFound)),
            LoadError::Io { .. }
        ));
    }

    #[test]
    fn obj_preflight_requires_materials_and_textures() {
        let dir = TempDir::new();
        let base = dir.0.canonicalize().unwrap();
        let obj = base.join("mesh.obj");
        let mtl = base.join("mesh.mtl");
        let texture = base.join("texture.png");
        std::fs::write(&obj, "mtllib mesh.mtl\nv 0 0 0\n").unwrap();
        assert!(
            matches!(ensure_model_assets_readable(&obj), Err(LoadError::Io { path, .. }) if path == mtl)
        );
        std::fs::write(&mtl, "newmtl A\nmap_Kd texture.png\n").unwrap();
        assert!(
            matches!(ensure_model_assets_readable(&obj), Err(LoadError::Io { path, .. }) if path == texture)
        );
        std::fs::write(&texture, b"texture").unwrap();
        ensure_model_assets_readable(&obj).unwrap();
    }

    #[test]
    fn obj_preflight_preserves_hash_characters_in_existing_asset_names() {
        let dir = TempDir::new();
        let obj = dir.0.join("mesh.obj");
        let texture = dir.0.join("checker#color.png");
        std::fs::write(&obj, "mtllib material#box.mtl\nv 0 0 0\n").unwrap();
        std::fs::write(
            dir.0.join("material#box.mtl"),
            "newmtl A\nmap_Kd -s 1 1 1 checker#color.png\n",
        )
        .unwrap();
        std::fs::write(&texture, b"texture").unwrap();
        ensure_model_assets_readable(&obj).unwrap();
        let before = crate::cache::cache_key(&obj, "obj-test").unwrap();
        std::fs::write(texture, b"changed texture").unwrap();
        assert_ne!(before, crate::cache::cache_key(&obj, "obj-test").unwrap());
    }

    #[test]
    fn obj_preflight_accepts_inline_comments_after_asset_names_with_spaces() {
        let dir = TempDir::new();
        let obj = dir.0.join("mesh.obj");
        std::fs::write(&obj, "mtllib material box.mtl # library comment\nv 0 0 0\n").unwrap();
        std::fs::write(
            dir.0.join("material box.mtl"),
            "newmtl A\nmap_Kd -s 1 1 1 texture with spaces.png # texture comment\n",
        )
        .unwrap();
        std::fs::write(dir.0.join("texture with spaces.png"), b"texture").unwrap();
        ensure_model_assets_readable(&obj).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn unreadable_material_is_not_silently_excluded_from_the_cache_key() {
        use std::os::unix::fs::PermissionsExt;

        let dir = TempDir::new();
        let base = dir.0.canonicalize().unwrap();
        let obj = base.join("mesh.obj");
        let mtl = base.join("mesh.mtl");
        std::fs::write(&obj, "mtllib mesh.mtl\nv 0 0 0\n").unwrap();
        std::fs::write(&mtl, "newmtl A\nKd 1 0 0\n").unwrap();
        std::fs::set_permissions(&mtl, std::fs::Permissions::from_mode(0o000)).unwrap();
        assert!(std::fs::metadata(&mtl).is_ok());
        if File::open(&mtl).is_ok() {
            eprintln!("SKIP read-permission scenario: this environment can open mode-000 files; actual access denial was not verified.");
            return;
        }
        assert!(
            matches!(ensure_model_assets_readable(&obj), Err(LoadError::PermissionDenied { path }) if path == mtl)
        );
        assert!(
            matches!(crate::cache::cache_key(&obj, "obj-test"), Err(LoadError::PermissionDenied { path }) if path == mtl)
        );
    }

    #[test]
    fn gltf_preflight_checks_percent_encoded_external_assets() {
        let dir = TempDir::new();
        let base = dir.0.canonicalize().unwrap();
        let source = base.join("model.gltf");
        let buffer = base.join("mesh data.bin");
        std::fs::write(
            &source,
            r#"{"asset":{"version":"2.0"},"buffers":[{"uri":"mesh%20data.bin","byteLength":4}]}"#,
        )
        .unwrap();
        assert!(
            matches!(ensure_model_assets_readable(&source), Err(LoadError::Io { path, .. }) if path == buffer)
        );
        std::fs::write(buffer, b"data").unwrap();
        ensure_model_assets_readable(&source).unwrap();
    }
}
