use std::path::Path;

use trivor_core::SceneSummary;

use crate::gltf_inspect::inspect_scene_summary_light;
use crate::LoadError;

pub type ProgressFn<'a> = dyn Fn(u8) + Send + Sync + 'a;

/// Fast metadata pass for the inspector (model-viewer loads geometry separately).
pub fn inspect_gltf_summary(
    path: &Path,
    progress: Option<&ProgressFn<'_>>,
) -> Result<SceneSummary, LoadError> {
    let report = |p: u8| {
        if let Some(f) = progress {
            f(p.min(100));
        }
    };

    report(0);
    report(40);
    let summary = inspect_scene_summary_light(path)?;
    report(100);
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::borrow::Cow;
    use std::sync::Mutex;

    #[test]
    fn ordinary_gltf_and_glb_use_transformed_header_metadata_and_report_progress() {
        let dir = crate::cache::tests::TempDir::new();
        let positions = [
            [0.0_f32, 0.0, 0.0],
            [2.0, 0.0, 0.0],
            [0.0, 3.0, 0.0],
            [2.0, 3.0, 4.0],
        ];
        let bin: Vec<u8> = positions
            .iter()
            .flatten()
            .flat_map(|value| value.to_le_bytes())
            .collect();
        let mut doc = serde_json::json!({
            "asset":{"version":"2.0"},"scene":0,"scenes":[{"nodes":[0]}],
            "nodes":[{"mesh":0,"scale":[2,3,4]}],
            "meshes":[{"primitives":[{"attributes":{"POSITION":0},"mode":5,"material":0}]}],
            "materials":[{}],
            "buffers":[{"byteLength":bin.len()}],
            "bufferViews":[{"buffer":0,"byteLength":bin.len()}],
            "accessors":[{"bufferView":0,"componentType":5126,"count":4,"type":"VEC3","min":[0,0,0],"max":[2,3,4]}]
        });
        let glb = gltf::binary::Glb {
            header: gltf::binary::Header {
                magic: *b"glTF",
                version: 2,
                length: 0,
            },
            json: Cow::Owned(serde_json::to_vec(&doc).unwrap()),
            bin: Some(Cow::Borrowed(&bin)),
        };
        std::fs::write(dir.0.join("ordinary.glb"), glb.to_vec().unwrap()).unwrap();
        doc["buffers"][0]["uri"] = serde_json::json!("geometry.bin");
        std::fs::write(
            dir.0.join("ordinary.gltf"),
            serde_json::to_vec(&doc).unwrap(),
        )
        .unwrap();
        std::fs::write(dir.0.join("geometry.bin"), bin).unwrap();

        for extension in ["gltf", "glb"] {
            let events = Mutex::new(Vec::new());
            let progress = |value| events.lock().unwrap().push(value);
            let summary = inspect_gltf_summary(
                &dir.0.join(format!("ordinary.{extension}")),
                Some(&progress),
            )
            .unwrap();
            assert_eq!((summary.vertex_count, summary.triangle_count), (4, 2));
            assert_eq!(
                (summary.bounds_w, summary.bounds_h, summary.bounds_d),
                (4.0, 9.0, 16.0)
            );
            assert_eq!(summary.materials[0].base_color, [1.0; 4]);
            let events = events.into_inner().unwrap();
            assert_eq!(events.first(), Some(&0));
            assert_eq!(events.last(), Some(&100));
            assert!(events.windows(2).all(|pair| pair[0] <= pair[1]));
        }
    }
}
