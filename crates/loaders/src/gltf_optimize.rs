//! Run meshoptimizer gltfpack to build a simplified EXT_meshopt preview GLB.

use crate::cache;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use crate::gltf_inspect::{inspect_gltf_file, needs_preview_optimize, GltfQuickStats};
use crate::LoadError;
use crate::ProgressFn;
use crate::ViewerDetail;

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

pub(crate) fn resolve_gltfpack() -> Option<PathBuf> {
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

// Avoid two full in-memory gltfpack imports running together. Waiting callers
// poll cancellation as well, instead of blocking behind a stale request.
static PREPARATION: Mutex<()> = Mutex::new(());

pub(crate) fn check_cancelled(source: &Path, cancelled: &AtomicBool) -> Result<(), LoadError> {
    if cancelled.load(Ordering::Relaxed) {
        return Err(crate::asset_uri::parse_error(
            source,
            "MODEL_PREPARATION_CANCELLED",
        ));
    }
    Ok(())
}

fn preparation_lock(
    source: &Path,
    cancelled: &AtomicBool,
) -> Result<MutexGuard<'static, ()>, LoadError> {
    loop {
        check_cancelled(source, cancelled)?;
        match PREPARATION.try_lock() {
            Ok(guard) => return Ok(guard),
            Err(std::sync::TryLockError::Poisoned(error)) => return Ok(error.into_inner()),
            Err(std::sync::TryLockError::WouldBlock) => {
                std::thread::sleep(Duration::from_millis(100))
            }
        }
    }
}

#[derive(Clone, Copy)]
pub(crate) struct ViewerBudget {
    pub triangles: u64,
    pub draw_calls: u64,
    pub geometry: u64,
    pub textures: u64,
    pub texture_edge: u32,
}

pub(crate) fn budget(level: ViewerDetail) -> ViewerBudget {
    match level {
        ViewerDetail::Detail => ViewerBudget {
            triangles: 2_000_000,
            draw_calls: 4096,
            geometry: 256 * 1024 * 1024,
            textures: 256 * 1024 * 1024,
            texture_edge: 1024,
        },
        _ => ViewerBudget {
            triangles: 300_000,
            draw_calls: 1024,
            geometry: 64 * 1024 * 1024,
            textures: 64 * 1024 * 1024,
            texture_edge: 512,
        },
    }
}

fn texture_limit(stats: &GltfQuickStats, budget: ViewerBudget) -> u32 {
    let per_image = budget.textures / (stats.image_count.max(1) as u64);
    // RGBA8 and a complete mip chain even on devices that cannot use GPU texture
    // compression. Round down to a power of two; -tl is a per-image limit.
    let mut edge = budget.texture_edge;
    while edge > 1 && (edge as u64).pow(2).saturating_mul(16) / 3 > per_image {
        edge /= 2;
    }
    edge
}

fn cache_path(
    source: &Path,
    level: ViewerDetail,
    cancelled: &AtomicBool,
) -> Result<PathBuf, LoadError> {
    let tag = match level {
        ViewerDetail::Detail => "detail-budget-v2-webp",
        _ => "preview-budget-v2-webp",
    };
    let mut hasher = DefaultHasher::new();
    tag.hash(&mut hasher);
    let mut paths = match source
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "gltf" | "glb" => crate::gltf_inspect::external_paths_cancellable(source, cancelled)?,
        _ => crate::cache::referenced_paths(source)?,
    };
    paths.insert(source.to_path_buf());
    for path in paths {
        path.hash(&mut hasher);
        let metadata =
            std::fs::metadata(&path).map_err(|e| crate::model_assets::io_error(&path, e))?;
        metadata.len().hash(&mut hasher);
        metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|t| t.as_nanos())
            .hash(&mut hasher);
    }
    Ok(crate::viewer_cache_dir().join(format!("{tag}-{:016x}.glb", hasher.finish())))
}

pub(crate) fn validate_budget(path: &Path, level: ViewerDetail) -> Result<(), LoadError> {
    if !cache::valid_glb(path) {
        return Err(crate::asset_uri::parse_error(
            path,
            "MODEL_PREPARATION_INVALID_OUTPUT",
        ));
    }
    let stats = inspect_gltf_file(path)?;
    if stats.texture_encoding_failed {
        return Err(crate::asset_uri::parse_error(
            path,
            "MODEL_PREPARATION_TEXTURE_FAILED",
        ));
    }
    let limits = budget(level);
    if stats.triangle_count > limits.triangles
        || stats.draw_calls > limits.draw_calls
        || stats.instance_count > 10_000
        || stats.geometry_bytes > limits.geometry
        || stats.texture_bytes > limits.textures
    {
        tracing::warn!(
            triangles = stats.triangle_count,
            geometry_bytes = stats.geometry_bytes,
            texture_bytes = stats.texture_bytes,
            ?level,
            "prepared model exceeds viewer budget"
        );
        return Err(crate::asset_uri::parse_error(
            path,
            "MODEL_PREPARATION_BUDGET_EXCEEDED",
        ));
    }
    // Output must be independent of the original directory.
    if !crate::gltf_inspect::external_paths(path)?.is_empty() {
        return Err(crate::asset_uri::parse_error(
            path,
            "MODEL_PREPARATION_EXTERNAL_ASSETS",
        ));
    }
    Ok(())
}

pub(crate) fn cached_stage(
    source: &Path,
    level: ViewerDetail,
    cancelled: &AtomicBool,
) -> Result<Option<PathBuf>, LoadError> {
    let path = cache_path(source, level, cancelled)?;
    Ok(validate_budget(&path, level).is_ok().then_some(path))
}

fn run_gltfpack(
    source: &Path,
    dest: &Path,
    stats: &GltfQuickStats,
    level: ViewerDetail,
    cancelled: &AtomicBool,
) -> Result<(), LoadError> {
    check_cancelled(source, cancelled)?;
    let gltfpack = resolve_gltfpack()
        .ok_or_else(|| crate::asset_uri::parse_error(source, "GLTFPACK_SIDECAR_MISSING"))?;
    let limits = budget(level);
    let ratio = if stats.triangle_count == 0 {
        0.05
    } else {
        (limits.triangles as f64 / stats.triangle_count as f64 * 0.95).min(1.0)
    };
    let mut command = Command::new(&gltfpack);
    command
        .arg("-i")
        .arg(source)
        .arg("-o")
        .arg(dest)
        // gltfpack 1.1's Basis encoder writes to hard-coded /tmp paths. Its
        // WebP encoder works in memory and respects -tl without sandbox grants.
        .args(["-c", "-tw", "-tj", "1", "-tl"])
        .arg(texture_limit(stats, limits).to_string())
        .arg("-si")
        .arg(format!("{ratio:.8}"))
        .arg("-sa");
    run_cancellable(&mut command, source, stats.file_size, cancelled)?;
    validate_budget(dest, level)?;
    let output = inspect_gltf_file(dest)?;
    if stats.triangle_count > 0 && output.triangle_count == 0 {
        return Err(crate::asset_uri::parse_error(
            source,
            "MODEL_PREPARATION_EMPTY_OUTPUT",
        ));
    }
    Ok(())
}

pub(crate) fn run_cancellable(
    command: &mut Command,
    source: &Path,
    file_size: u64,
    cancelled: &AtomicBool,
) -> Result<(), LoadError> {
    check_cancelled(source, cancelled)?;
    let child = crate::gltf_process::ManagedChild::spawn(
        command.stdout(Stdio::null()).stderr(Stdio::piped()),
    )
    .map_err(|e| {
        crate::asset_uri::parse_error(source, format!("GLTFPACK_PREVIEW_FAILED:{e}"))
    })?;
    // Always drain stderr so a verbose/erroring child cannot block on a full pipe.
    let stderr = child.take_stderr().expect("piped stderr");
    let reader = std::thread::spawn(move || {
        let mut stderr = stderr;
        let mut retained = Vec::new();
        let mut bytes = [0u8; 4096];
        while let Ok(count) = stderr.read(&mut bytes) {
            if count == 0 {
                break;
            }
            let keep = count.min(64 * 1024usize - retained.len());
            retained.extend_from_slice(&bytes[..keep]);
        }
        retained
    });
    let status = loop {
        if cancelled.load(Ordering::Relaxed) {
            child.terminate();
            let _ = reader.join();
            return check_cancelled(source, cancelled);
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(error) => {
                child.terminate();
                let _ = reader.join();
                return Err(crate::asset_uri::parse_error(
                    source,
                    format!("GLTFPACK_PREVIEW_FAILED:{error}"),
                ));
            }
        }
    };
    let stderr = reader.join().unwrap_or_default();
    check_cancelled(source, cancelled)?;
    if !stderr.is_empty() {
        tracing::warn!(path=%source.display(), stderr=%String::from_utf8_lossy(&stderr), "gltfpack diagnostic");
    }
    if !status.success() {
        return Err(crate::asset_uri::parse_error(
            source,
            format!("GLTFPACK_PREVIEW_FAILED:{}", file_size),
        ));
    }
    Ok(())
}

pub(crate) fn optimize_stage_to_cache(
    source: &Path,
    stats: &GltfQuickStats,
    level: ViewerDetail,
    cancelled: &AtomicBool,
    progress: Option<&ProgressFn<'_>>,
) -> Result<PathBuf, LoadError> {
    check_cancelled(source, cancelled)?;
    if stats.required_draco {
        return Err(crate::asset_uri::parse_error(
            source,
            "MODEL_PREPARATION_UNSUPPORTED_DRACO",
        ));
    }
    tracing::info!(path=%source.display(), meshes=stats.mesh_count, instances=stats.instance_count, draws=stats.draw_calls, ?level, "preparing budgeted viewer model");
    let _guard = preparation_lock(source, cancelled)?;
    let dest = cache_path(source, level, cancelled)?;
    if validate_budget(&dest, level).is_err() {
        if let Some(progress) = progress {
            progress(0);
        }
        // No intermediate percentages: gltfpack does not report reliable progress.
        cache::write_atomic(&dest, |temp| {
            run_gltfpack(source, temp, stats, level, cancelled)
        })?;
    }
    check_cancelled(source, cancelled)?;
    if let Some(progress) = progress {
        progress(100);
    }
    Ok(dest)
}

pub fn maybe_optimize_preview(
    source: &Path,
    stats: &GltfQuickStats,
    progress: Option<&ProgressFn<'_>>,
) -> Result<PathBuf, LoadError> {
    if !needs_preview_optimize(stats) {
        return Ok(source.to_path_buf());
    }
    optimize_stage_to_cache(
        source,
        stats,
        ViewerDetail::Preview,
        &AtomicBool::new(false),
        progress,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn total_texture_budget_scales_edge_with_image_count() {
        let mut stats = GltfQuickStats {
            file_size: 0,
            buffer_bytes: 0,
            mesh_count: 0,
            draw_calls: 0,
            instance_count: 0,
            triangle_count: 0,
            geometry_bytes: 0,
            texture_bytes: 0,
            image_count: 1,
            required_draco: false,
            texture_encoding_failed: false,
        };
        assert_eq!(texture_limit(&stats, budget(ViewerDetail::Preview)), 512);
        stats.image_count = 200;
        let edge = texture_limit(&stats, budget(ViewerDetail::Preview));
        assert_eq!(edge, 128);
        assert!((edge as u64).pow(2) * 16 / 3 * 200 <= budget(ViewerDetail::Preview).textures);
    }

    #[test]
    fn cancelled_waiter_does_not_wait_for_another_conversion() {
        let _guard = PREPARATION.lock().unwrap();
        let cancel = AtomicBool::new(true);
        let error = preparation_lock(Path::new("model.glb"), &cancel).unwrap_err();
        assert!(error.to_string().contains("MODEL_PREPARATION_CANCELLED"));
    }
    #[cfg(unix)]
    #[test]
    fn cancellation_kills_and_reaps_running_child_and_removes_partial_cache() {
        let dir = crate::cache::tests::TempDir::new();
        let dest = dir.0.join("cache.glb");
        let pid_path = dir.0.join("child.pid");
        let cancel = std::sync::Arc::new(AtomicBool::new(false));
        let started = std::time::Instant::now();
        let worker = {
            let cancel = cancel.clone();
            let dest = dest.clone();
            let pid_path = pid_path.clone();
            std::thread::spawn(move || {
                cache::write_atomic(&dest, |temp| {
                    let mut command = Command::new("/bin/sh");
                    command
                        .arg("-c")
                        .arg("echo $$ > \"$1\"; echo partial > \"$2\"; exec sleep 30")
                        .arg("test")
                        .arg(&pid_path)
                        .arg(temp);
                    run_cancellable(&mut command, &dest, 0, &cancel)
                })
            })
        };
        while !pid_path.exists() && started.elapsed() < Duration::from_secs(3) {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(pid_path.exists(), "child started");
        let pid = std::fs::read_to_string(&pid_path).unwrap();
        cancel.store(true, Ordering::Relaxed);
        let error = worker.join().unwrap().unwrap_err();
        assert!(error.to_string().contains("MODEL_PREPARATION_CANCELLED"));
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(!dest.exists());
        assert!(
            !Command::new("kill")
                .args(["-0", pid.trim()])
                .stderr(Stdio::null())
                .status()
                .unwrap()
                .success(),
            "child has been reaped"
        );
        assert!(!std::fs::read_dir(&dir.0).unwrap().any(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".trivor-")));
    }

    #[test]
    fn output_budget_rejects_small_compressed_files_with_excess_decoded_geometry() {
        let dir = crate::cache::tests::TempDir::new();
        let path = dir.0.join("over-budget.glb");
        let doc = serde_json::json!({"asset":{"version":"2.0"},"accessors":[{"count":100000000,"type":"MAT4","componentType":5126}]});
        let mut json = serde_json::to_vec(&doc).unwrap();
        while json.len() % 4 != 0 {
            json.push(b' ');
        }
        let mut bytes = b"glTF".to_vec();
        bytes.extend_from_slice(&2u32.to_le_bytes());
        bytes.extend_from_slice(&((20 + json.len()) as u32).to_le_bytes());
        bytes.extend_from_slice(&(json.len() as u32).to_le_bytes());
        bytes.extend_from_slice(b"JSON");
        bytes.extend(json);
        std::fs::write(&path, bytes).unwrap();
        assert!(validate_budget(&path, ViewerDetail::Preview)
            .unwrap_err()
            .to_string()
            .contains("BUDGET_EXCEEDED"));
        assert!(validate_budget(&path, ViewerDetail::Detail)
            .unwrap_err()
            .to_string()
            .contains("BUDGET_EXCEEDED"));
    }
    #[test]
    fn initial_request_reuses_valid_detail_cache_and_changed_source_has_new_identity() {
        let dir = crate::cache::tests::TempDir::new();
        let source = dir.0.join("large.gltf");
        std::fs::write(&source, r#"{"asset":{"version":"2.0"},"accessors":[{"type":"VEC3","count":9000000}],"meshes":[{"primitives":[{"attributes":{"POSITION":0}}]}]}"#).unwrap();
        let source = source.canonicalize().unwrap();
        let cancel = AtomicBool::new(false);
        let dest = cache_path(&source, ViewerDetail::Detail, &cancel).unwrap();
        let tiny = dir.0.join("cached.gltf");
        std::fs::write(&tiny, r#"{"asset":{"version":"2.0"}}"#).unwrap();
        std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
        crate::export_model_glb(&tiny, &dest).unwrap();
        let prepared = crate::prepare_viewer_model(&source, None, &cancel, None).unwrap();
        assert_eq!(prepared.path, dest);
        assert_eq!(prepared.level, "detail");
        assert_eq!(prepared.next_level, None);
        assert_ne!(
            cache_path(&source, ViewerDetail::Preview, &cancel).unwrap(),
            dest
        );
        std::fs::write(
            &source,
            r#"{"asset":{"version":"2.0"},"extras":{"changed":true}}"#,
        )
        .unwrap();
        assert_ne!(
            cache_path(&source, ViewerDetail::Detail, &cancel).unwrap(),
            dest
        );
    }
    #[test]
    fn gltfpack_error_texture_is_reported_as_encoding_failure_not_budget() {
        let dir = crate::cache::tests::TempDir::new();
        let path = dir.0.join("failed-texture.glb");
        let glb = gltf::binary::Glb {
            header: gltf::binary::Header {
                magic: *b"glTF",
                version: 2,
                length: 0,
            },
            json: std::borrow::Cow::Owned(
                serde_json::to_vec(&serde_json::json!({
                    "asset":{"version":"2.0"},
                    "images":[{"uri":"data:image/png;base64,ERR/"}]
                }))
                .unwrap(),
            ),
            bin: None,
        };
        std::fs::write(&path, glb.to_vec().unwrap()).unwrap();
        assert!(validate_budget(&path, ViewerDetail::Preview)
            .unwrap_err()
            .to_string()
            .contains("MODEL_PREPARATION_TEXTURE_FAILED"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn bundled_webp_encoding_needs_no_writable_working_directory_or_temp_directory() {
        let gltfpack = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../src-tauri/bin")
            .join(super::sidecar_name());
        if !gltfpack.is_file() {
            eprintln!("SKIP bundled WebP regression: bundled platform sidecar is unavailable");
            return;
        }
        let dir = crate::cache::tests::TempDir::new();
        let texture = dir.0.join("texture.png");
        image::RgbaImage::from_pixel(1024, 1024, image::Rgba([40, 120, 240, 255]))
            .save(&texture)
            .unwrap();
        let input = dir.0.join("model.obj");
        std::fs::write(&input, "mtllib model.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nvt 0 0\nvt 1 0\nvt 0 1\nusemtl test\nf 1/1 2/2 3/3\n").unwrap();
        std::fs::write(
            dir.0.join("model.mtl"),
            "newmtl test\nKd 1 1 1\nmap_Kd texture.png\n",
        )
        .unwrap();
        let dest = dir.0.join("webp.glb");
        let output = Command::new(gltfpack)
            .args(["-i"])
            .arg(&input)
            .arg("-o")
            .arg(&dest)
            .args(["-c", "-tw", "-tj", "1", "-tl", "128"])
            .current_dir("/")
            .env("TMPDIR", dir.0.join("absent"))
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        validate_budget(&dest, ViewerDetail::Preview).unwrap();
        let doc: serde_json::Value = crate::gltf_metadata::read(&dest).unwrap();
        assert_eq!(doc["images"][0]["mimeType"], "image/webp");
        let stats = inspect_gltf_file(&dest).unwrap();
        assert_eq!(stats.image_count, 1);
        assert_eq!(stats.texture_bytes, 128 * 128 * 16 / 3);
        assert!(!stats.texture_encoding_failed);
        assert!(!dir.0.join("absent").exists());
    }
}
