//! Progressive, budget-checked viewer assets. Original sources remain untouched.
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

use serde::{Deserialize, Serialize};

use crate::gltf_inspect::{
    inspect_gltf_file_cancellable, needs_preview_optimize, PREVIEW_OPTIMIZE_BYTES,
};
use crate::gltf_optimize::{cached_stage, check_cancelled, optimize_stage_to_cache};
use crate::{LoadError, ProgressFn};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ViewerDetail {
    Structure,
    Preview,
    Detail,
}

#[derive(Debug, Serialize)]
pub struct PreparedViewerModel {
    pub path: PathBuf,
    pub level: String,
    pub next_level: Option<ViewerDetail>,
}

pub(crate) fn reject_large_legacy_import(path: &Path) -> Result<(), LoadError> {
    let unsupported =
        || crate::asset_uri::parse_error(path, "MODEL_PREPARATION_LARGE_FORMAT_UNSUPPORTED");
    let size = crate::limits::file_size(path)?;
    if size >= PREVIEW_OPTIMIZE_BYTES {
        return Err(unsupported());
    }
    if path
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("obj"))
    {
        let mut total_bytes = 0u64;
        let mut decoded_textures = 0u64;
        for dependency in crate::cache::referenced_paths(path)? {
            total_bytes = total_bytes.saturating_add(crate::limits::file_size(&dependency)?);
            if total_bytes >= PREVIEW_OPTIMIZE_BYTES {
                return Err(unsupported());
            }
            if dependency
                .extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| {
                    matches!(
                        e.to_ascii_lowercase().as_str(),
                        "png" | "jpg" | "jpeg" | "webp" | "ktx" | "ktx2" | "tga" | "bmp"
                    )
                })
            {
                decoded_textures = decoded_textures.saturating_add(
                    crate::gltf_inspect::external_image_decoded_bytes(&dependency)?,
                );
                if decoded_textures > 128 * 1024 * 1024 {
                    return Err(unsupported());
                }
            }
        }
    }
    Ok(())
}

pub fn prepare_viewer_model(
    source: &Path,
    level: Option<ViewerDetail>,
    cancelled: &AtomicBool,
    progress: Option<&ProgressFn<'_>>,
) -> Result<PreparedViewerModel, LoadError> {
    check_cancelled(source, cancelled)?;
    let source = source
        .canonicalize()
        .map_err(|e| crate::model_assets::io_error(source, e))?;
    let ext = source
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if ext != "glb" && ext != "gltf" {
        if ext == "obj" || ext == "stl" {
            reject_large_legacy_import(&source)?;
        }
        let path = crate::resolve_viewer_model(&source, progress)?;
        check_cancelled(&source, cancelled)?;
        return Ok(PreparedViewerModel {
            path,
            level: "original".into(),
            next_level: None,
        });
    }
    let stats = inspect_gltf_file_cancellable(&source, cancelled)?;
    check_cancelled(&source, cancelled)?;
    if !needs_preview_optimize(&stats) {
        let path = crate::resolve_viewer_model(&source, progress)?;
        check_cancelled(&source, cancelled)?;
        return Ok(PreparedViewerModel {
            path,
            level: "original".into(),
            next_level: None,
        });
    }
    if level.is_none() {
        if let Some(path) = cached_stage(&source, ViewerDetail::Detail, cancelled)? {
            check_cancelled(&source, cancelled)?;
            if let Some(progress) = progress {
                progress(100);
            }
            return Ok(PreparedViewerModel {
                path,
                level: "detail".into(),
                next_level: None,
            });
        }
        if let Some(path) = cached_stage(&source, ViewerDetail::Preview, cancelled)? {
            check_cancelled(&source, cancelled)?;
            if let Some(progress) = progress {
                progress(100);
            }
            return Ok(PreparedViewerModel {
                path,
                level: "preview".into(),
                next_level: Some(ViewerDetail::Detail),
            });
        }
    }
    let requested = level.unwrap_or(ViewerDetail::Structure);
    if requested == ViewerDetail::Structure {
        match crate::gltf_structure::structure_preview_to_cache(&source, cancelled) {
            Ok(path) => {
                check_cancelled(&source, cancelled)?;
                if let Some(progress) = progress {
                    progress(100);
                }
                return Ok(PreparedViewerModel {
                    path,
                    level: "structure".into(),
                    next_level: Some(ViewerDetail::Preview),
                });
            }
            Err(LoadError::Parse { message, .. }) if message == "MODEL_STRUCTURE_UNAVAILABLE" => {}
            Err(error) => return Err(error),
        }
    }
    let stage = if requested == ViewerDetail::Detail {
        ViewerDetail::Detail
    } else {
        ViewerDetail::Preview
    };
    let path = optimize_stage_to_cache(&source, &stats, stage, cancelled, progress)?;
    Ok(PreparedViewerModel {
        path,
        level: if stage == ViewerDetail::Detail {
            "detail"
        } else {
            "preview"
        }
        .into(),
        next_level: (stage == ViewerDetail::Preview).then_some(ViewerDetail::Detail),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn large_required_draco_keeps_real_structure_instead_of_returning_original() {
        let dir = crate::cache::tests::TempDir::new();
        let source = dir.0.join("required-draco.gltf");
        let mut doc = serde_json::json!({
            "asset":{"version":"2.0"},"extensionsRequired":["KHR_draco_mesh_compression"],
            "scene":0,"scenes":[{"nodes":[0]}],
            "nodes":[{"mesh":0}],"meshes":[{"primitives":[{"attributes":{"POSITION":0}}]}],
            "accessors":[{"count":9000000,"type":"VEC3","componentType":5126,"min":[0,0,0],"max":[2,3,4]}]
        });
        let bytes = serde_json::to_vec(&doc).unwrap();
        std::fs::write(&source, &bytes).unwrap();
        let cancelled = AtomicBool::new(false);
        let initial = prepare_viewer_model(&source, None, &cancelled, None).unwrap();
        assert_eq!(initial.level, "structure");
        assert_eq!(initial.next_level, Some(ViewerDetail::Preview));
        assert_ne!(initial.path, source);
        assert!(crate::cache::valid_glb(&initial.path));
        let error =
            prepare_viewer_model(&source, initial.next_level, &cancelled, None).unwrap_err();
        assert!(error
            .to_string()
            .contains("MODEL_PREPARATION_UNSUPPORTED_DRACO"));
        assert!(initial.path.is_file());
        assert_eq!(std::fs::read(&source).unwrap(), bytes);

        // Missing real bounds goes directly to geometric preparation. It must
        // report the unsupported decoder, never fabricate a successful box.
        doc["accessors"][0].as_object_mut().unwrap().remove("min");
        doc["accessors"][0].as_object_mut().unwrap().remove("max");
        std::fs::write(&source, serde_json::to_vec(&doc).unwrap()).unwrap();
        let error = prepare_viewer_model(&source, None, &cancelled, None).unwrap_err();
        assert!(error
            .to_string()
            .contains("MODEL_PREPARATION_UNSUPPORTED_DRACO"));
    }

    #[test]
    fn small_model_keeps_original_level_and_large_legacy_formats_fail_before_import() {
        let dir = crate::cache::tests::TempDir::new();
        let small = dir.0.join("empty.gltf");
        std::fs::write(&small, r#"{"asset":{"version":"2.0"}}"#).unwrap();
        let result = prepare_viewer_model(&small, None, &AtomicBool::new(false), None).unwrap();
        assert_eq!(result.level, "original");
        assert!(result.next_level.is_none());
        for ext in ["obj", "stl"] {
            let source = dir.0.join(format!("large.{ext}"));
            std::fs::File::create(&source)
                .unwrap()
                .set_len(PREVIEW_OPTIMIZE_BYTES)
                .unwrap();
            let cancelled = AtomicBool::new(false);
            let error = prepare_viewer_model(&source, None, &cancelled, None).unwrap_err();
            assert!(error
                .to_string()
                .contains("MODEL_PREPARATION_LARGE_FORMAT_UNSUPPORTED"));
            assert!(crate::load_scene_summary(&source, None)
                .unwrap_err()
                .to_string()
                .contains("MODEL_PREPARATION_LARGE_FORMAT_UNSUPPORTED"));
            assert!(
                crate::ensure_model_assets_readable_cancellable(&source, &cancelled)
                    .unwrap_err()
                    .to_string()
                    .contains("MODEL_PREPARATION_LARGE_FORMAT_UNSUPPORTED")
            );
        }
    }
}
