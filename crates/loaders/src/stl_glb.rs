//! Minimal binary GLB writer for STL meshes.

use std::fs::File;
use std::io::BufReader;
use std::path::Path;

use serde_json::json;
use stl_io::IndexedMesh;

use crate::LoadError;

pub fn write_stl_as_glb(source: &Path, dest: &Path) -> Result<(), LoadError> {
    let file = File::open(source).map_err(|e| LoadError::Io {
        path: source.to_path_buf(),
        message: e.to_string(),
    })?;
    let mesh = stl_io::read_stl(&mut BufReader::new(file)).map_err(|e| LoadError::Parse {
        path: source.to_path_buf(),
        message: format!("failed to read STL: {e}"),
    })?;

    if mesh.faces.len() > u32::MAX as usize / 3
        || mesh
            .vertices
            .iter()
            .any(|vertex| vertex.0.iter().any(|value| !value.is_finite()))
    {
        return Err(LoadError::Parse {
            path: source.to_path_buf(),
            message: "STL contains invalid coordinates or too many vertices".into(),
        });
    }

    let (positions, indices, min, max) = flatten_mesh(&mesh);
    if positions.is_empty() || indices.is_empty() {
        return Err(LoadError::Parse {
            path: source.to_path_buf(),
            message: "STL mesh is empty".into(),
        });
    }

    let mut bin = Vec::new();
    for v in &positions {
        for component in v {
            bin.extend_from_slice(&component.to_le_bytes());
        }
    }
    let index_offset = bin.len();
    for idx in &indices {
        bin.extend_from_slice(&idx.to_le_bytes());
    }
    while bin.len() % 4 != 0 {
        bin.push(0);
    }

    let vertex_count = positions.len();
    let index_count = indices.len();
    let pos_bytes = vertex_count * 12;
    let idx_bytes = index_count * 4;

    let gltf = json!({
        "asset": { "version": "2.0", "generator": "Trivor" },
        "scene": 0,
        "scenes": [{ "nodes": [0] }],
        "nodes": [{ "mesh": 0 }],
        "meshes": [{
            "primitives": [{
                "attributes": { "POSITION": 0 },
                "indices": 1
            }]
        }],
        "accessors": [
            {
                "bufferView": 0,
                "componentType": 5126,
                "count": vertex_count,
                "type": "VEC3",
                "min": min,
                "max": max
            },
            {
                "bufferView": 1,
                "componentType": 5125,
                "count": index_count,
                "type": "SCALAR"
            }
        ],
        "bufferViews": [
            { "buffer": 0, "byteOffset": 0, "byteLength": pos_bytes },
            { "buffer": 0, "byteOffset": index_offset, "byteLength": idx_bytes }
        ],
        "buffers": [{ "byteLength": bin.len() }]
    });

    let json_bytes = serde_json::to_vec(&gltf).map_err(|e| LoadError::Parse {
        path: source.to_path_buf(),
        message: format!("failed to serialize glTF JSON: {e}"),
    })?;

    let mut json_padded = json_bytes;
    while json_padded.len() % 4 != 0 {
        json_padded.push(b' ');
    }

    let total_len = 12 + 8 + json_padded.len() + 8 + bin.len();
    if total_len > u32::MAX as usize {
        return Err(LoadError::Parse {
            path: source.to_path_buf(),
            message: "STL exceeds the GLB 4 GiB size limit".into(),
        });
    }
    let mut out = Vec::with_capacity(total_len);
    out.extend_from_slice(b"glTF");
    out.extend_from_slice(&2u32.to_le_bytes());
    out.extend_from_slice(&(total_len as u32).to_le_bytes());
    out.extend_from_slice(&(json_padded.len() as u32).to_le_bytes());
    out.extend_from_slice(b"JSON");
    out.extend_from_slice(&json_padded);
    out.extend_from_slice(&(bin.len() as u32).to_le_bytes());
    out.extend_from_slice(b"BIN\0");
    out.extend_from_slice(&bin);

    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| LoadError::Io {
            path: parent.to_path_buf(),
            message: e.to_string(),
        })?;
    }
    std::fs::write(dest, out).map_err(|e| LoadError::Io {
        path: dest.to_path_buf(),
        message: e.to_string(),
    })?;
    Ok(())
}

fn flatten_mesh(mesh: &IndexedMesh) -> (Vec<[f32; 3]>, Vec<u32>, [f64; 3], [f64; 3]) {
    let mut positions = Vec::new();
    let mut indices = Vec::new();
    let mut min = [f64::INFINITY; 3];
    let mut max = [f64::NEG_INFINITY; 3];

    for face in &mesh.faces {
        let mut tri = [0u32; 3];
        for (i, idx) in face.vertices.iter().enumerate() {
            let v = mesh.vertices[*idx as usize];
            let p = [v[0] as f64, v[1] as f64, v[2] as f64];
            for axis in 0..3 {
                min[axis] = min[axis].min(p[axis]);
                max[axis] = max[axis].max(p[axis]);
            }
            positions.push([v[0], v[1], v[2]]);
            tri[i] = (positions.len() - 1) as u32;
        }
        indices.extend_from_slice(&tri);
    }

    if positions.is_empty() {
        return (positions, indices, [0.0; 3], [0.0; 3]);
    }
    (positions, indices, min, max)
}
