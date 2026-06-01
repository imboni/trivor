//! Run meshoptimizer gltfpack to build a simplified EXT_meshopt preview GLB.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;
use std::time::UNIX_EPOCH;

use crate::gltf_inspect::{needs_preview_optimize, preview_simplify_ratio, GltfQuickStats};
use crate::LoadError;
use crate::ProgressFn;

static GLTFPACK_PATH: OnceLock<PathBuf> = OnceLock::new();

pub fn set_gltfpack_path(path: PathBuf) {
    let path = canonical_gltfpack_path(path);
    if path.is_file() {
        let _ = GLTFPACK_PATH.set(path);
    }
}

fn canonical_gltfpack_path(path: PathBuf) -> PathBuf {
    path.canonicalize().unwrap_or(path)
}

pub fn gltfpack_configured() -> bool {
    resolve_gltfpack().is_some()
}

fn resolve_gltfpack() -> Option<PathBuf> {
    if let Some(path) = GLTFPACK_PATH.get() {
        if path.is_file() {
            return Some(path.clone());
        }
    }
    if let Ok(env) = std::env::var("TRIVOR_GLTFPACK") {
        let path = canonical_gltfpack_path(PathBuf::from(env));
        if path.is_file() {
            return Some(path);
        }
    }
    discover_gltfpack_from_exe_dir()
}

pub fn ensure_gltfpack_configured() {
    if gltfpack_configured() {
        return;
    }
    if let Some(path) = discover_gltfpack_from_exe_dir() {
        set_gltfpack_path(path);
    }
}

/// Dev / fallback bundle path (Tauri `src-tauri/bin`).
pub fn set_gltfpack_dev_bundle(manifest_dir: PathBuf) {
    if gltfpack_configured() {
        return;
    }
    let sidecar = sidecar_name();
    let dev = manifest_dir.join("bin").join(sidecar);
    if dev.is_file() {
        set_gltfpack_path(dev);
    }
}

fn sidecar_name() -> &'static str {
    if cfg!(target_arch = "aarch64") {
        "gltfpack-aarch64-apple-darwin"
    } else {
        "gltfpack-x86_64-apple-darwin"
    }
}

/// Resolve bundled sidecar next to the running executable (Tauri externalBin).
pub fn discover_gltfpack_from_exe_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let mut dir = exe.parent()?;
    for _ in 0..5 {
        for name in [
            "gltfpack",
            "gltfpack-universal-apple-darwin",
            sidecar_name(),
        ] {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(canonical_gltfpack_path(candidate));
            }
        }
        dir = dir.parent()?;
    }
    None
}

fn report_progress(progress: Option<&ProgressFn<'_>>, pct: u8) {
    if let Some(f) = progress {
        f(pct.min(100));
    }
}

fn preview_cache_key(source: &Path, stats: &GltfQuickStats) -> Result<String, LoadError> {
    let meta = std::fs::metadata(source).map_err(|e| LoadError::Io {
        path: source.to_path_buf(),
        message: e.to_string(),
    })?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let stem = source
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("model");
    let ratio = preview_simplify_ratio(stats.file_size);
    Ok(format!("{stem}-{mtime}-preview-{ratio:.3}"))
}

fn preview_cache_usable(cached: &Path, source: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(cached) else {
        return false;
    };
    if meta.len() < 256 {
        return false;
    }
    let Ok(src_meta) = std::fs::metadata(source) else {
        return false;
    };
    match (meta.modified(), src_meta.modified()) {
        (Ok(c), Ok(s)) => c >= s,
        _ => false,
    }
}

fn preview_failed_error(source: &Path, file_size: u64) -> LoadError {
    LoadError::Parse {
        path: source.to_path_buf(),
        message: format!("GLTFPACK_PREVIEW_FAILED:{file_size}"),
    }
}

fn sidecar_missing_error(source: &Path) -> LoadError {
    LoadError::Parse {
        path: source.to_path_buf(),
        message: "GLTFPACK_SIDECAR_MISSING".into(),
    }
}

fn run_gltfpack(source: &Path, dest: &Path, ratio: f32, file_size: u64) -> Result<(), LoadError> {
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
        .arg("-si")
        .arg(format!("{ratio:.4}"))
        .output()
        .map_err(|e| {
            tracing::warn!(path = %source.display(), %e, "failed to run gltfpack");
            preview_failed_error(source, file_size)
        })?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    tracing::warn!(
        path = %source.display(),
        exit = output.status.code().unwrap_or(-1),
        stderr = %stderr.trim(),
        stdout = %stdout.trim(),
        "gltfpack failed"
    );
    Err(preview_failed_error(source, file_size))
}

pub fn optimize_preview_to_cache(
    source: &Path,
    stats: &GltfQuickStats,
    progress: Option<&ProgressFn<'_>>,
) -> Result<PathBuf, LoadError> {
    let cache_dir = crate::viewer_cache_dir();
    std::fs::create_dir_all(&cache_dir).map_err(|e| LoadError::Io {
        path: cache_dir.clone(),
        message: e.to_string(),
    })?;

    let key = preview_cache_key(source, stats)?;
    let dest = cache_dir.join(format!("{key}.glb"));

    let needs_run = !preview_cache_usable(&dest, source);

    report_progress(progress, 2);
    if needs_run {
        if dest.is_file() {
            let _ = std::fs::remove_file(&dest);
        }
        let ratio = preview_simplify_ratio(stats.file_size);
        tracing::info!(
            path = %source.display(),
            file_mb = stats.file_size / (1024 * 1024),
            meshes = stats.mesh_count,
            triangles = stats.triangle_count,
            ratio,
            "building meshopt preview with gltfpack"
        );
        report_progress(progress, 10);
        run_gltfpack(source, &dest, ratio, stats.file_size)?;
        report_progress(progress, 95);
    }
    report_progress(progress, 100);
    Ok(dest)
}

pub fn maybe_optimize_preview(
    source: &Path,
    stats: &GltfQuickStats,
    progress: Option<&ProgressFn<'_>>,
) -> Result<PathBuf, LoadError> {
    ensure_gltfpack_configured();
    if !needs_preview_optimize(stats) {
        return Ok(source.to_path_buf());
    }
    report_progress(progress, 1);
    if !gltfpack_configured() {
        return Err(sidecar_missing_error(source));
    }
    optimize_preview_to_cache(source, stats, progress)
}
