//! Import OBJ / STL into cached GLB for model-viewer.

use crate::cache;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::gltf_loader::inspect_gltf_summary;
use crate::gltf_optimize::resolve_gltfpack;
use crate::LoadError;
use crate::ProgressFn;
use trivor_core::SceneSummary;

use crate::stl_glb;

fn report_progress(progress: Option<&ProgressFn<'_>>, pct: u8) {
    if let Some(f) = progress {
        f(pct.min(100));
    }
}

fn sidecar_missing_error(source: &Path) -> LoadError {
    LoadError::Parse {
        path: source.to_path_buf(),
        message: "GLTFPACK_SIDECAR_MISSING".into(),
    }
}

fn import_failed_error(source: &Path, detail: &str) -> LoadError {
    LoadError::Parse {
        path: source.to_path_buf(),
        message: format!("IMPORT_FAILED:{detail}"),
    }
}

fn run_gltfpack_import(source: &Path, dest: &Path) -> Result<(), LoadError> {
    let gltfpack = resolve_gltfpack().ok_or_else(|| sidecar_missing_error(source))?;
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| LoadError::Io {
            path: parent.to_path_buf(),
            message: e.to_string(),
        })?;
    }

    let output = Command::new(&gltfpack)
        .arg("-i")
        .arg(source)
        .arg("-o")
        .arg(dest)
        .arg("-cc")
        .arg("-noq")
        .output()
        .map_err(|e| {
            tracing::warn!(path = %source.display(), %e, "failed to run gltfpack import");
            import_failed_error(source, "gltfpack")
        })?;

    if output.status.success() && cache::valid_glb(dest) {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    tracing::warn!(
        path = %source.display(),
        exit = output.status.code().unwrap_or(-1),
        stderr = %stderr.trim(),
        "gltfpack import failed"
    );
    Err(import_failed_error(source, "gltfpack"))
}

/// Convert OBJ to cached GLB via bundled gltfpack (full fidelity, no simplify).
pub fn import_obj_to_cache(
    source: &Path,
    progress: Option<&ProgressFn<'_>>,
) -> Result<PathBuf, LoadError> {
    report_progress(progress, 5);
    crate::ensure_model_assets_readable(source)?;
    let cache_dir = crate::viewer_cache_dir();
    std::fs::create_dir_all(&cache_dir).map_err(|e| LoadError::Io {
        path: cache_dir.clone(),
        message: e.to_string(),
    })?;

    let key = cache::cache_key(source, "imported-obj-v3")?;
    let dest = cache_dir.join(format!("{key}.glb"));

    if !cache::valid_glb(&dest) {
        report_progress(progress, 20);
        cache::write_atomic(&dest, |temp| run_gltfpack_import(source, temp))?;
    }
    report_progress(progress, 100);
    Ok(dest)
}

/// Convert STL to cached GLB (native writer, no external sidecar).
pub fn import_stl_to_cache(
    source: &Path,
    progress: Option<&ProgressFn<'_>>,
) -> Result<PathBuf, LoadError> {
    report_progress(progress, 5);
    let cache_dir = crate::viewer_cache_dir();
    std::fs::create_dir_all(&cache_dir).map_err(|e| LoadError::Io {
        path: cache_dir.clone(),
        message: e.to_string(),
    })?;

    let key = cache::cache_key(source, "imported-stl-v2")?;
    let dest = cache_dir.join(format!("{key}.glb"));

    if !cache::valid_glb(&dest) {
        report_progress(progress, 25);
        cache::write_atomic(&dest, |temp| stl_glb::write_stl_as_glb(source, temp))?;
    }
    report_progress(progress, 100);
    Ok(dest)
}

/// Inspector metadata for imported formats (convert-then-inspect, preserve source format label).
pub fn load_imported_scene_summary(
    source: &Path,
    format: &str,
    progress: Option<&ProgressFn<'_>>,
) -> Result<SceneSummary, LoadError> {
    let source = source.canonicalize().map_err(|e| LoadError::Io {
        path: source.to_path_buf(),
        message: e.to_string(),
    })?;
    let source = source.as_path();
    let glb = match format {
        "obj" => import_obj_to_cache(source, progress)?,
        "stl" => import_stl_to_cache(source, progress)?,
        other => return Err(LoadError::UnsupportedFormat(other.into())),
    };
    let mut summary = inspect_gltf_summary(&glb, None)?;
    summary.format = format.to_string();
    summary.path = source.to_string_lossy().into_owned();
    summary.name = source
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("model")
        .to_string();
    summary.file_size = crate::file_size(source)?;
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cache::tests::TempDir;

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    #[test]
    fn bundled_obj_import_and_export_preserve_geometry() {
        let bundle = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../src-tauri/bin/gltfpack-aarch64-apple-darwin");
        crate::set_gltfpack_path(bundle);
        let dir = TempDir::new();
        let source = dir.0.join("triangle.obj");
        std::fs::write(&source, "v 0 0 0\nv 2 0 0\nv 0 3 0\nf 1 2 3\n").unwrap();
        let summary = crate::load_scene_summary(&source, None).unwrap();
        assert_eq!(summary.name, "triangle.obj");
        assert_eq!(summary.triangle_count, 1);
        assert_eq!(
            (summary.bounds_w, summary.bounds_h, summary.bounds_d),
            (2.0, 3.0, 0.0)
        );
        let dest = dir.0.join("exported.glb");
        crate::export_model_glb(&source, &dest).unwrap();
        assert!(cache::valid_glb(&dest));
        let exported = crate::inspect_gltf_summary(&dest, None).unwrap();
        assert_eq!(exported.triangle_count, 1);
        assert_eq!((exported.bounds_w, exported.bounds_h), (2.0, 3.0));
        let imported = import_obj_to_cache(&source, None).unwrap();
        std::fs::remove_file(imported).unwrap();
    }

    #[test]
    fn stl_summary_preserves_filename_path_and_geometry() {
        let dir = TempDir::new();
        let source = dir.0.join("triangle.STL");
        std::fs::write(&source, "solid triangle\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 2 0 0\nvertex 0 3 0\nendloop\nendfacet\nendsolid triangle\n").unwrap();
        let summary = crate::load_scene_summary(&source, None).unwrap();
        assert_eq!(summary.name, "triangle.STL");
        assert_eq!(
            summary.path,
            source.canonicalize().unwrap().to_string_lossy()
        );
        assert_eq!(summary.format, "stl");
        assert_eq!(summary.triangle_count, 1);
        assert_eq!(summary.vertex_count, 3);
        assert_eq!(
            (summary.bounds_w, summary.bounds_h, summary.bounds_d),
            (2.0, 3.0, 0.0)
        );
        let imported = import_stl_to_cache(&source, None).unwrap();
        assert!(cache::valid_glb(&imported));
        std::fs::remove_file(imported).unwrap();
    }
}
