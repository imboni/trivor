use super::*;
use crate::cache::tests::TempDir;

fn read_json(path: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

fn add_animation(source: &Path) -> (Value, Vec<u8>) {
    let mut doc = read_json(source);
    let mut bin = Vec::new();
    for value in [0.0_f32, 1.0, 0.0, 0.0, 0.0, 1.0, 2.0, 3.0] {
        bin.extend_from_slice(&value.to_le_bytes());
    }
    let buffers = doc["buffers"].as_array_mut().unwrap();
    let buffer = buffers.len();
    buffers.push(json!({
        "byteLength": bin.len(), "uri": "animation%20data.bin", "name": "Original animation",
        "extras": {"author":"fixture"}, "extensions":{"VENDOR_metadata":{"value":42}}
    }));
    let views = doc["bufferViews"].as_array_mut().unwrap();
    let view = views.len();
    views.push(json!({"buffer":buffer,"byteOffset":0,"byteLength":8}));
    views.push(json!({"buffer":buffer,"byteOffset":8,"byteLength":24}));
    let accessors = doc["accessors"].as_array_mut().unwrap();
    let accessor = accessors.len();
    accessors.push(json!({"bufferView":view,"componentType":5126,"count":2,"type":"SCALAR","min":[0],"max":[1]}));
    accessors.push(json!({"bufferView":view+1,"componentType":5126,"count":2,"type":"VEC3"}));
    doc["animations"] = json!([{
        "samplers":[{"input":accessor,"output":accessor+1,"interpolation":"LINEAR"}],
        "channels":[{"sampler":0,"target":{"node":0,"path":"translation"}}],
        "extras":{"note":"preserved"}
    }]);
    doc["extensionsUsed"] = json!(["VENDOR_metadata"]);
    doc["extensions"] = json!({"VENDOR_metadata":{"nested":[1,2,3]}});
    std::fs::write(source.parent().unwrap().join("animation data.bin"), &bin).unwrap();
    std::fs::write(source, serde_json::to_vec(&doc).unwrap()).unwrap();
    (doc, bin)
}

#[test]
fn embedded_gltf_reopens_glb_and_gltf_geometry_textures_and_animation() {
    for textured in [false, true] {
        for from_glb in [false, true] {
            let input = TempDir::new();
            let output = TempDir::new();
            let gltf = super::tests::write_standard_cube_fixture(&input.0, textured);
            let (original_doc, animation) = add_animation(&gltf);
            let source = if from_glb {
                let glb = input.0.join("source.glb");
                export_model_glb(&gltf, &glb).unwrap();
                glb
            } else {
                gltf
            };
            let source_bytes = std::fs::read(&source).unwrap();
            let destination = output.0.join("standalone.gltf");
            export_model_gltf(&source, &destination).unwrap();
            assert_eq!(std::fs::read(&source).unwrap(), source_bytes);
            assert_eq!(
                std::fs::read(input.0.join("animation data.bin")).unwrap(),
                animation
            );
            assert_eq!(std::fs::read_dir(&output.0).unwrap().count(), 1);
            drop(input);

            let bytes = std::fs::read(&destination).unwrap();
            let json: Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(json["animations"], original_doc["animations"]);
            assert_eq!(json["extensions"], original_doc["extensions"]);
            for buffer in json["buffers"].as_array().unwrap() {
                assert!(buffer["uri"]
                    .as_str()
                    .unwrap()
                    .starts_with("data:application/octet-stream;base64,"));
                assert_eq!(
                    read_asset(&destination, buffer["uri"].as_str().unwrap())
                        .unwrap()
                        .len() as u64,
                    buffer["byteLength"].as_u64().unwrap()
                );
            }
            if !from_glb {
                for field in ["name", "extras", "extensions", "byteLength"] {
                    assert_eq!(json["buffers"][1][field], original_doc["buffers"][1][field]);
                }
                assert_eq!(json["bufferViews"], original_doc["bufferViews"]);
                assert_eq!(
                    read_asset(&destination, json["buffers"][1]["uri"].as_str().unwrap()).unwrap(),
                    animation
                );
            }
            for image in json["images"].as_array().into_iter().flatten() {
                if let Some(uri) = image["uri"].as_str() {
                    assert!(uri.starts_with("data:image/"));
                }
            }
            gltf::Gltf::from_slice(&bytes).expect("standard glTF schema must remain valid");
            // gltf-rs import_slice rejects even data URI images without a base path;
            // this isolated directory contains only the exported glTF file.
            let (doc, buffers, images) = gltf::import(&destination)
                .expect("export must validate and reopen without any original files");
            assert_eq!(images.len(), usize::from(textured));
            if textured {
                assert_eq!((images[0].width, images[0].height), (2, 2));
                assert_eq!(&images[0].pixels[..4], &[255, 180, 120, 255]);
            }
            let mesh = doc.meshes().next().unwrap();
            let primitive = mesh.primitives().next().unwrap();
            let reader = primitive.reader(|buffer| Some(&buffers[buffer.index()]));
            assert_eq!(reader.read_positions().unwrap().count(), 8);
            assert_eq!(reader.read_indices().unwrap().into_u32().count(), 36);
            let animation = doc.animations().next().unwrap();
            let channel = animation.channels().next().unwrap();
            let reader = channel.reader(|buffer| Some(&buffers[buffer.index()]));
            assert_eq!(
                reader.read_inputs().unwrap().collect::<Vec<_>>(),
                [0.0, 1.0]
            );
            match reader.read_outputs().unwrap() {
                gltf::animation::util::ReadOutputs::Translations(values) => {
                    assert_eq!(
                        values.collect::<Vec<_>>(),
                        [[0.0, 0.0, 0.0], [1.0, 2.0, 3.0]]
                    );
                }
                _ => panic!("animation output type changed"),
            }
            let summary = crate::load_scene_summary(&destination, None).unwrap();
            assert_eq!((summary.vertex_count, summary.triangle_count), (8, 12));
            // A previously embedded glTF is also a supported original source.
            export_model_gltf(&destination, &destination).unwrap();
            assert_eq!(read_json(&destination), json);
        }
    }
}

#[test]
fn embedded_gltf_excludes_glb_alignment_padding() {
    let dir = TempDir::new();
    let source = dir.0.join("unaligned.glb");
    let glb = Glb {
        header: Header {
            magic: *b"glTF",
            version: 2,
            length: 0,
        },
        json: Cow::Owned(
            serde_json::to_vec(&json!({
                "asset":{"version":"2.0"},
                "buffers":[{"byteLength":3,"name":"Keep me"}],
                "bufferViews":[{"buffer":0,"byteLength":3}]
            }))
            .unwrap(),
        ),
        bin: Some(Cow::Borrowed(&[1, 2, 3])),
    }
    .to_vec()
    .unwrap();
    assert_eq!(Glb::from_slice(&glb).unwrap().bin.unwrap().len(), 4);
    std::fs::write(&source, &glb).unwrap();
    let destination = dir.0.join("unaligned.gltf");
    export_model_gltf(&source, &destination).unwrap();
    let json = read_json(&destination);
    assert_eq!(json["buffers"][0]["name"], "Keep me");
    assert_eq!(
        read_asset(&destination, json["buffers"][0]["uri"].as_str().unwrap()).unwrap(),
        [1, 2, 3]
    );
    gltf::import(&destination).unwrap();
    assert_eq!(std::fs::read(source).unwrap(), glb);
}

#[test]
fn embedded_gltf_preserves_meshopt_virtual_fallback_and_basis_texture() {
    for tagged in [false, true] {
        let input = TempDir::new();
        let output = TempDir::new();
        let source = input.0.join("compressed.gltf");
        let payload = base64::engine::general_purpose::STANDARD.decode(
        "oAAAAAEz8wAA//////8AAAABPwwAAP////8AAAABAMAAAP8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAgL+amRm/zczMvgDh8CAwEQAVIBYgFyUXAHaHVmd4qYZliWiYAWkAAAAAAA=="
    ).unwrap();
        std::fs::write(input.0.join("compressed.bin"), &payload).unwrap();
        let texture = b"\xabKTX 20\xbb\r\n\x1a\nopaque-test-texture";
        std::fs::write(input.0.join("texture.ktx2"), texture).unwrap();
        let mut doc = json!({
            "asset":{"version":"2.0"},
            "extensionsUsed":["EXT_meshopt_compression","KHR_texture_basisu"],
            "extensionsRequired":["EXT_meshopt_compression","KHR_texture_basisu"],
            "buffers":[
                {"uri":"compressed.bin","byteLength":100,"extras":{"keep":true}},
                {"byteLength":1000000000,"extensions":{"EXT_meshopt_compression":{"fallback":true}}}
            ],
            "bufferViews":[
                {"buffer":1,"byteOffset":0,"byteLength":96,"byteStride":12,"target":34962,"extensions":{"EXT_meshopt_compression":{"buffer":0,"byteOffset":0,"byteLength":67,"byteStride":12,"mode":"ATTRIBUTES","count":8}}},
                {"buffer":1,"byteOffset":96,"byteLength":72,"target":34963,"extensions":{"EXT_meshopt_compression":{"buffer":0,"byteOffset":68,"byteLength":29,"byteStride":2,"mode":"TRIANGLES","count":36}}}
            ],
            "accessors":[
                {"bufferView":0,"componentType":5126,"count":8,"type":"VEC3","min":[-1,-0.6,-0.4],"max":[1,0.6,0.4]},
                {"bufferView":1,"componentType":5123,"count":36,"type":"SCALAR"}
            ],
            "images":[{"uri":"texture.ktx2","extras":{"keep":true}}],
            "textures":[{"extensions":{"KHR_texture_basisu":{"source":0}}}],
            "meshes":[{"primitives":[{"attributes":{"POSITION":0},"indices":1}]}],
            "nodes":[{"mesh":0}],"scenes":[{"nodes":[0]}],"scene":0
        });
        if !tagged {
            doc["buffers"][1]
                .as_object_mut()
                .unwrap()
                .remove("extensions");
        }
        std::fs::write(&source, serde_json::to_vec(&doc).unwrap()).unwrap();
        let destination = output.0.join("compressed.gltf");
        export_model_gltf(&source, &destination).unwrap();
        drop(input);
        let exported = read_json(&destination);
        assert!(std::fs::metadata(&destination).unwrap().len() < 10_000);
        assert_eq!(exported["buffers"][1], doc["buffers"][1]);
        assert_eq!(
            exported["buffers"][0]["extras"],
            doc["buffers"][0]["extras"]
        );
        assert_eq!(
            read_asset(
                &destination,
                exported["buffers"][0]["uri"].as_str().unwrap()
            )
            .unwrap(),
            payload
        );
        assert_eq!(
            read_asset(&destination, exported["images"][0]["uri"].as_str().unwrap()).unwrap(),
            texture
        );
        for field in [
            "bufferViews",
            "accessors",
            "meshes",
            "textures",
            "extensionsUsed",
            "extensionsRequired",
        ] {
            assert_eq!(exported[field], doc[field]);
        }
        let summary = crate::load_scene_summary(&destination, None).unwrap();
        assert_eq!((summary.vertex_count, summary.triangle_count), (8, 12));
        // gltf-rs does not decode these required extensions. Repack and embed again,
        // verifying the actual compressed bytes and virtual fallback remain intact.
        let glb = output.0.join("compressed.glb");
        export_model_glb(&destination, &glb).unwrap();
        let roundtrip = output.0.join("roundtrip.gltf");
        export_model_gltf(&glb, &roundtrip).unwrap();
        let roundtrip = read_json(&roundtrip);
        assert_eq!(roundtrip["buffers"][1], doc["buffers"][1]);
        let binary = read_asset(&glb, roundtrip["buffers"][0]["uri"].as_str().unwrap()).unwrap();
        assert_eq!(&binary[..payload.len()], payload);
    }
}

#[test]
fn embedded_gltf_empty_scene_has_no_artificial_resources() {
    let input = TempDir::new();
    let source = input.0.join("empty.gltf");
    let doc = json!({"asset":{"version":"2.0"},"extras":{"empty":true}});
    std::fs::write(&source, serde_json::to_vec(&doc).unwrap()).unwrap();
    for from_glb in [false, true] {
        let source = if from_glb {
            let glb = input.0.join("empty.glb");
            export_model_glb(&source, &glb).unwrap();
            glb
        } else {
            source.clone()
        };
        let output = TempDir::new();
        let destination = output.0.join("empty.gltf");
        export_model_gltf(&source, &destination).unwrap();
        assert_eq!(read_json(&destination), doc);
        gltf::Gltf::from_slice(&std::fs::read(destination).unwrap()).unwrap();
        assert_eq!(std::fs::read_dir(output.0.as_path()).unwrap().count(), 1);
    }
}

#[test]
fn embedded_gltf_invalid_resources_never_overwrite_existing_destination() {
    let dir = TempDir::new();
    let source = dir.0.join("source.gltf");
    let destination = dir.0.join("existing.gltf");
    let original = b"existing destination";
    std::fs::write(&destination, original).unwrap();
    let invalid = [
        "not JSON",
        r#"{"asset":{"version":"2.0"},"buffers":[{"uri":"missing.bin","byteLength":4}]}"#,
        r#"{"asset":{"version":"2.0"},"buffers":[{"uri":"data:application/octet-stream;base64,AQ==","byteLength":4}]}"#,
        r#"{"asset":{"version":"2.0"},"buffers":{}}"#,
        r#"{"asset":{"version":"2.0"},"images":null}"#,
        r#"{"asset":{"version":"2.0"},"images":[{"bufferView":12,"mimeType":"image/png"}]}"#,
        r#"{"asset":{"version":"2.0"},"buffers":[{"uri":"data:application/octet-stream;base64,AQIDBA==","byteLength":4}],"bufferViews":[{"buffer":0,"byteLength":4,"byteOffset":1}]}"#,
        r#"{"asset":{"version":"2.0"},"buffers":[{"uri":"data:application/octet-stream;base64,AQIDBA==","byteLength":4}],"bufferViews":[{"buffer":0,"byteLength":4,"byteOffset":-1}]}"#,
        r#"{"asset":{"version":"2.0"},"extensionsRequired":["EXT_meshopt_compression"],"buffers":[{"byteLength":4,"extensions":{"EXT_meshopt_compression":{"fallback":true}}}],"bufferViews":[{"buffer":0,"byteLength":4}]}"#,
        r#"{"asset":{"version":"2.0"},"extensionsRequired":["EXT_meshopt_compression"],"buffers":[{"byteLength":4}],"bufferViews":[{"buffer":0,"byteLength":4,"extensions":{"EXT_meshopt_compression":{"buffer":0,"byteLength":4}}}]}"#,
    ];
    for data in invalid {
        std::fs::write(&source, data).unwrap();
        assert!(
            export_model_gltf(&source, &destination).is_err(),
            "must reject {data}"
        );
        assert_eq!(std::fs::read(&destination).unwrap(), original);
        assert_eq!(std::fs::read(&source).unwrap(), data.as_bytes());
    }
}

#[test]
fn embedded_gltf_exports_stl_geometry() {
    let input = TempDir::new();
    let output = TempDir::new();
    let source = input.0.join("triangle.stl");
    let data = "solid triangle\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 2 0 0\nvertex 0 3 0\nendloop\nendfacet\nendsolid triangle\n";
    std::fs::write(&source, data).unwrap();
    let destination = output.0.join("triangle.gltf");
    export_model_gltf(&source, &destination).unwrap();
    assert_eq!(std::fs::read_to_string(source).unwrap(), data);
    drop(input);
    gltf::import_slice(&std::fs::read(&destination).unwrap()).unwrap();
    let summary = crate::load_scene_summary(&destination, None).unwrap();
    assert_eq!((summary.vertex_count, summary.triangle_count), (3, 1));
    assert_eq!((summary.bounds_w, summary.bounds_h), (2.0, 3.0));
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
#[test]
fn embedded_gltf_exports_bundled_obj_materials_and_geometry() {
    let bundle = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../src-tauri/bin/gltfpack-aarch64-apple-darwin");
    crate::set_gltfpack_path(bundle);
    let input = TempDir::new();
    let output = TempDir::new();
    let source = input.0.join("triangle.obj");
    let data = "mtllib triangle.mtl\nv 0 0 0\nv 2 0 0\nv 0 3 0\nusemtl Red\nf 1 2 3\n";
    std::fs::write(&source, data).unwrap();
    std::fs::write(input.0.join("triangle.mtl"), "newmtl Red\nKd 1 0 0\n").unwrap();
    let destination = output.0.join("triangle.gltf");
    export_model_gltf(&source, &destination).unwrap();
    assert_eq!(std::fs::read_to_string(source).unwrap(), data);
    drop(input);
    let summary = crate::load_scene_summary(&destination, None).unwrap();
    assert_eq!(
        (
            summary.vertex_count,
            summary.triangle_count,
            summary.material_count
        ),
        (3, 1, 1)
    );
    assert_eq!((summary.bounds_w, summary.bounds_h), (2.0, 3.0));
    let doc = read_json(&destination);
    assert_eq!(
        doc["materials"][0]["pbrMetallicRoughness"]["baseColorFactor"],
        json!([1, 0, 0, 1])
    );
    assert!(doc["buffers"][0]["uri"]
        .as_str()
        .unwrap()
        .starts_with("data:"));
}
