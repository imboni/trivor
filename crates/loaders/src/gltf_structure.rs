//! Bounded, header-only structural overviews. Every visible box comes from an
//! accessor's real bounds; this is deliberately not a replacement geometry LOD.

use std::collections::{hash_map::DefaultHasher, HashMap};
use std::fmt;
use std::fs::File;
use std::hash::{Hash, Hasher};
use std::io::{BufReader, Read, Write};
use std::marker::PhantomData;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::UNIX_EPOCH;

use glam::{Mat4, Quat, Vec3};
use serde::de::{Error, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer};
use serde_json::json;

use crate::model_assets::io_error;
use crate::{cache, LoadError};

const MAX_JSON_BYTES: u64 = 32 * 1024 * 1024;
const MAX_NODES: usize = 100_000;
const MAX_ITEMS: usize = 200_000;
const MAX_DEPTH: usize = 1024;
const MAX_VISITS: usize = 200_000;
const MAX_BOXES: usize = 2048;
const DEFAULT_COLOR: [f32; 4] = [0.58, 0.67, 0.78, 1.0];

fn bounded_vec<'de, D, T, const LIMIT: usize>(deserializer: D) -> Result<Vec<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    struct Bounded<T, const LIMIT: usize>(PhantomData<T>);
    impl<'de, T: Deserialize<'de>, const LIMIT: usize> Visitor<'de> for Bounded<T, LIMIT> {
        type Value = Vec<T>;
        fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
            write!(formatter, "at most {LIMIT} structural items")
        }
        fn visit_seq<A: SeqAccess<'de>>(self, mut sequence: A) -> Result<Self::Value, A::Error> {
            let mut result = Vec::new();
            while let Some(item) = sequence.next_element()? {
                if result.len() == LIMIT {
                    return Err(A::Error::custom("structure item limit exceeded"));
                }
                result.push(item);
            }
            Ok(result)
        }
    }
    deserializer.deserialize_seq(Bounded::<T, LIMIT>(PhantomData))
}

macro_rules! vector_reader {
    ($name:ident, $type:ty, $limit:expr) => {
        fn $name<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<$type>, D::Error> {
            bounded_vec::<D, $type, $limit>(deserializer)
        }
    };
}
vector_reader!(nodes, Node, MAX_NODES);
vector_reader!(meshes, Mesh, MAX_NODES);
vector_reader!(accessors, Accessor, MAX_ITEMS);
vector_reader!(materials, Material, MAX_NODES);
vector_reader!(scenes, Scene, MAX_NODES);
vector_reader!(indices, usize, MAX_NODES);
vector_reader!(primitives, Primitive, MAX_ITEMS);
vector_reader!(components, f64, 16);

#[derive(Default, Deserialize)]
struct Document {
    #[serde(default, deserialize_with = "nodes")]
    nodes: Vec<Node>,
    #[serde(default, deserialize_with = "meshes")]
    meshes: Vec<Mesh>,
    #[serde(default, deserialize_with = "accessors")]
    accessors: Vec<Accessor>,
    #[serde(default, deserialize_with = "materials")]
    materials: Vec<Material>,
    #[serde(default, deserialize_with = "scenes")]
    scenes: Vec<Scene>,
    scene: Option<usize>,
}

#[derive(Default, Deserialize)]
struct Node {
    mesh: Option<usize>,
    #[serde(default, deserialize_with = "indices")]
    children: Vec<usize>,
    matrix: Option<[f32; 16]>,
    translation: Option<[f32; 3]>,
    rotation: Option<[f32; 4]>,
    scale: Option<[f32; 3]>,
    #[serde(default)]
    extensions: NodeExtensions,
}

#[derive(Default, Deserialize)]
struct NodeExtensions {
    #[serde(rename = "EXT_mesh_gpu_instancing")]
    gpu_instancing: Option<serde::de::IgnoredAny>,
}

#[derive(Default, Deserialize)]
struct Scene {
    #[serde(default, deserialize_with = "indices")]
    nodes: Vec<usize>,
}

#[derive(Default, Deserialize)]
struct Mesh {
    #[serde(default, deserialize_with = "primitives")]
    primitives: Vec<Primitive>,
}

#[derive(Default, Deserialize)]
struct Primitive {
    #[serde(default)]
    attributes: Attributes,
    material: Option<usize>,
}

#[derive(Default, Deserialize)]
struct Attributes {
    #[serde(rename = "POSITION")]
    position: Option<usize>,
}

#[derive(Default, Deserialize)]
struct Accessor {
    #[serde(default, deserialize_with = "components")]
    min: Vec<f64>,
    #[serde(default, deserialize_with = "components")]
    max: Vec<f64>,
    #[serde(default)]
    normalized: bool,
    #[serde(default, rename = "componentType")]
    component_type: u32,
}

#[derive(Default, Deserialize)]
struct Material {
    #[serde(default, rename = "pbrMetallicRoughness")]
    pbr: Pbr,
}

#[derive(Default, Deserialize)]
struct Pbr {
    #[serde(rename = "baseColorFactor")]
    color: Option<[f32; 4]>,
}

fn unavailable(source: &Path) -> LoadError {
    LoadError::Parse {
        path: source.to_path_buf(),
        message: "MODEL_STRUCTURE_UNAVAILABLE".into(),
    }
}

fn check_cancelled(source: &Path, cancelled: &AtomicBool) -> Result<(), LoadError> {
    if cancelled.load(Ordering::Relaxed) {
        Err(LoadError::Parse {
            path: source.to_path_buf(),
            message: "MODEL_PREPARATION_CANCELLED".into(),
        })
    } else {
        Ok(())
    }
}

struct CancellableReader<'a, R> {
    reader: R,
    cancelled: &'a AtomicBool,
}

impl<R: Read> Read for CancellableReader<'_, R> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if self.cancelled.load(Ordering::Relaxed) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Other,
                "MODEL_PREPARATION_CANCELLED",
            ));
        }
        self.reader.read(buffer)
    }
}

fn read_document(source: &Path, cancelled: &AtomicBool) -> Result<Document, LoadError> {
    check_cancelled(source, cancelled)?;
    if source
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("gltf"))
    {
        // Inline payloads must be scanned in JSON, but are never retained. Keep
        // collection limits and cancellation even for multi-GB data URI files.
        return crate::gltf_metadata::read_cancellable(source, cancelled).map_err(
            |error| match error {
                LoadError::Parse { ref message, .. }
                    if message != "MODEL_PREPARATION_CANCELLED" =>
                {
                    unavailable(source)
                }
                _ => error,
            },
        );
    }
    let mut file = File::open(source).map_err(|error| io_error(source, error))?;
    let length = file
        .metadata()
        .map_err(|error| io_error(source, error))?
        .len();
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    let json_length = if extension.eq_ignore_ascii_case("glb") {
        let mut header = [0u8; 20];
        file.read_exact(&mut header)
            .map_err(|error| io_error(source, error))?;
        if &header[..4] != b"glTF"
            || u32::from_le_bytes(header[4..8].try_into().unwrap()) != 2
            || u32::from_le_bytes(header[8..12].try_into().unwrap()) as u64 != length
            || &header[16..20] != b"JSON"
        {
            return Err(unavailable(source));
        }
        let size = u32::from_le_bytes(header[12..16].try_into().unwrap()) as u64;
        if size % 4 != 0 || size + 20 > length {
            return Err(unavailable(source));
        }
        size
    } else {
        return Err(unavailable(source));
    };
    // GLB has a dedicated JSON chunk: never let an oversized header expand memory.
    if json_length > MAX_JSON_BYTES {
        return Err(unavailable(source));
    }
    let reader = CancellableReader {
        // Take is inside BufReader: even read-ahead cannot consume any BIN bytes.
        reader: BufReader::new(file.take(json_length)),
        cancelled,
    };
    let parsed = serde_json::from_reader(reader);
    check_cancelled(source, cancelled)?;
    parsed.map_err(|_| unavailable(source))
}

fn local_transform(node: &Node) -> Option<Mat4> {
    let transform = if let Some(matrix) = node.matrix {
        Mat4::from_cols_array(&matrix)
    } else {
        let rotation = Quat::from_array(node.rotation.unwrap_or([0.0, 0.0, 0.0, 1.0]));
        if !rotation.is_finite() || rotation.length_squared() < 1e-12 {
            return None;
        }
        Mat4::from_scale_rotation_translation(
            Vec3::from_array(node.scale.unwrap_or([1.0; 3])),
            rotation.normalize(),
            Vec3::from_array(node.translation.unwrap_or([0.0; 3])),
        )
    };
    transform.is_finite().then_some(transform)
}

fn accessor_bounds(accessor: &Accessor) -> Option<(Vec3, Vec3)> {
    if accessor.min.len() != 3 || accessor.max.len() != 3 {
        return None;
    }
    let normalize = |value: f64| -> f32 {
        (if accessor.normalized {
            match accessor.component_type {
                5120 => (value / 127.0).max(-1.0),
                5121 => value / 255.0,
                5122 => (value / 32767.0).max(-1.0),
                5123 => value / 65535.0,
                _ => value,
            }
        } else {
            value
        }) as f32
    };
    let min = Vec3::new(
        normalize(accessor.min[0]),
        normalize(accessor.min[1]),
        normalize(accessor.min[2]),
    );
    let max = Vec3::new(
        normalize(accessor.max[0]),
        normalize(accessor.max[1]),
        normalize(accessor.max[2]),
    );
    (min.is_finite() && max.is_finite() && min.cmple(max).all()).then_some((min, max))
}

#[derive(Clone)]
struct ProxyBox {
    transform: Mat4,
    color: [f32; 4],
}

struct Overview {
    boxes: Vec<ProxyBox>,
    represented: usize,
    aggregated: usize,
}

fn world_bounds(transform: Mat4, min: Vec3, max: Vec3) -> Option<(Vec3, Vec3)> {
    let mut low = Vec3::splat(f32::INFINITY);
    let mut high = Vec3::splat(f32::NEG_INFINITY);
    for x in [min.x, max.x] {
        for y in [min.y, max.y] {
            for z in [min.z, max.z] {
                let point = transform.transform_point3(Vec3::new(x, y, z));
                if !point.is_finite() {
                    return None;
                }
                low = low.min(point);
                high = high.max(point);
            }
        }
    }
    Some((low, high))
}

fn box_transform(world: Mat4, min: Vec3, max: Vec3) -> Option<Mat4> {
    let extent = max - min;
    let largest = extent.max_element();
    if !extent.is_finite() || largest <= 0.0 {
        return None;
    }
    // Preserve a planar accessor as a visibly thin slab, not a singular matrix.
    let size = extent.max(Vec3::splat(largest * 0.0001));
    let center = min + extent * 0.5;
    let result = world * Mat4::from_translation(center) * Mat4::from_scale(size);
    result.is_finite().then_some(result)
}

fn build_overview(
    document: &Document,
    source: &Path,
    cancelled: &AtomicBool,
) -> Result<Overview, LoadError> {
    enum Frame {
        Enter(usize, Mat4, usize),
        Exit(usize),
    }
    let scene = document
        .scenes
        .get(document.scene.unwrap_or(0))
        .ok_or_else(|| unavailable(source))?;
    let mut stack: Vec<Frame> = scene
        .nodes
        .iter()
        .rev()
        .map(|index| Frame::Enter(*index, Mat4::IDENTITY, 0))
        .collect();
    let mut active = vec![false; document.nodes.len()];
    let mut boxes = Vec::new();
    let mut represented = 0;
    let mut aggregated = 0;
    let mut overflow: Option<(Vec3, Vec3)> = None;
    let mut visits = 0;
    let mut queued = stack.len();
    while let Some(frame) = stack.pop() {
        check_cancelled(source, cancelled)?;
        let (index, parent, depth) = match frame {
            Frame::Exit(index) => {
                active[index] = false;
                continue;
            }
            Frame::Enter(index, parent, depth) => (index, parent, depth),
        };
        visits += 1;
        if visits > MAX_VISITS || depth > MAX_DEPTH {
            return Err(unavailable(source));
        }
        let node = document
            .nodes
            .get(index)
            .ok_or_else(|| unavailable(source))?;
        if active[index] {
            return Err(unavailable(source));
        }
        active[index] = true;
        let world = parent * local_transform(node).ok_or_else(|| unavailable(source))?;
        if !world.is_finite() {
            return Err(unavailable(source));
        }
        if let Some(mesh) = node.mesh {
            // Instance transforms live in binary accessors. A base mesh box
            // would misrepresent their occupied space and establish a wrong
            // initial camera. Let actual geometry preparation handle them.
            if node.extensions.gpu_instancing.is_some() {
                return Err(unavailable(source));
            }
            let mesh = document
                .meshes
                .get(mesh)
                .ok_or_else(|| unavailable(source))?;
            for primitive in &mesh.primitives {
                check_cancelled(source, cancelled)?;
                let accessor = primitive
                    .attributes
                    .position
                    .and_then(|index| document.accessors.get(index))
                    .ok_or_else(|| unavailable(source))?;
                // A partial overview would silently omit unknown geometry. Let the
                // caller fall back when any visible primitive lacks real bounds.
                let (min, max) = accessor_bounds(accessor).ok_or_else(|| unavailable(source))?;
                let transform =
                    box_transform(world, min, max).ok_or_else(|| unavailable(source))?;
                let color = match primitive.material {
                    Some(index) => document
                        .materials
                        .get(index)
                        .ok_or_else(|| unavailable(source))?
                        .pbr
                        .color
                        .unwrap_or(DEFAULT_COLOR),
                    None => DEFAULT_COLOR,
                };
                if color.iter().any(|component| !component.is_finite()) {
                    return Err(unavailable(source));
                }
                represented += 1;
                if represented > MAX_ITEMS {
                    return Err(unavailable(source));
                }
                if boxes.len() < MAX_BOXES - 1 {
                    boxes.push(ProxyBox { transform, color });
                } else {
                    let (low, high) =
                        world_bounds(world, min, max).ok_or_else(|| unavailable(source))?;
                    overflow = Some(match overflow {
                        Some((a, b)) => (a.min(low), b.max(high)),
                        None => (low, high),
                    });
                    aggregated += 1;
                }
            }
        }
        queued = queued
            .checked_add(node.children.len())
            .ok_or_else(|| unavailable(source))?;
        if queued > MAX_VISITS {
            return Err(unavailable(source));
        }
        stack.push(Frame::Exit(index));
        for child in node.children.iter().rev() {
            stack.push(Frame::Enter(*child, world, depth + 1));
        }
    }
    if let Some((min, max)) = overflow {
        boxes.push(ProxyBox {
            transform: box_transform(Mat4::IDENTITY, min, max)
                .ok_or_else(|| unavailable(source))?,
            color: DEFAULT_COLOR,
        });
    }
    if boxes.is_empty() {
        return Err(unavailable(source));
    }
    Ok(Overview {
        boxes,
        represented,
        aggregated,
    })
}

fn unit_cube() -> Vec<u8> {
    let corners = [
        [-0.5f32, -0.5, -0.5],
        [0.5, -0.5, -0.5],
        [0.5, 0.5, -0.5],
        [-0.5, 0.5, -0.5],
        [-0.5, -0.5, 0.5],
        [0.5, -0.5, 0.5],
        [0.5, 0.5, 0.5],
        [-0.5, 0.5, 0.5],
    ];
    let faces = [
        ([4, 5, 6, 7], [0.0f32, 0.0, 1.0]),
        ([1, 0, 3, 2], [0.0, 0.0, -1.0]),
        ([0, 4, 7, 3], [-1.0, 0.0, 0.0]),
        ([5, 1, 2, 6], [1.0, 0.0, 0.0]),
        ([3, 7, 6, 2], [0.0, 1.0, 0.0]),
        ([0, 1, 5, 4], [0.0, -1.0, 0.0]),
    ];
    let mut bytes = Vec::with_capacity(648);
    for (indices, _) in &faces {
        for index in indices {
            for value in corners[*index] {
                bytes.extend_from_slice(&value.to_le_bytes());
            }
        }
    }
    for (_, normal) in &faces {
        for _ in 0..4 {
            for value in normal {
                bytes.extend_from_slice(&value.to_le_bytes());
            }
        }
    }
    for face in 0..6u16 {
        for index in [0, 1, 2, 0, 2, 3] {
            bytes.extend_from_slice(&(face * 4 + index).to_le_bytes());
        }
    }
    bytes
}

fn encode_overview(overview: &Overview) -> Vec<u8> {
    let mut material_indices = HashMap::new();
    let mut materials = Vec::new();
    let mut meshes = Vec::new();
    let mut nodes = Vec::new();
    for proxy in &overview.boxes {
        let key = proxy
            .color
            .map(|value| (value.clamp(0.0, 1.0) * 255.0).round() as u8);
        let index = *material_indices.entry(key).or_insert_with(|| {
            let index = materials.len();
            // Solid, matte boxes explicitly communicate structure, not textured fidelity.
            materials.push(json!({"name":"Structure overview", "doubleSided":true,
                "pbrMetallicRoughness":{"baseColorFactor":[key[0] as f32/255.0,key[1] as f32/255.0,key[2] as f32/255.0,1.0],"metallicFactor":0,"roughnessFactor":1}}));
            meshes.push(json!({"primitives":[{"attributes":{"POSITION":0,"NORMAL":1},"indices":2,"material":index}]}));
            index
        });
        nodes.push(json!({"mesh":index,"matrix":proxy.transform.to_cols_array()}));
    }
    let bin = unit_cube();
    let doc = json!({
        "asset":{"version":"2.0","generator":"Trivor structural bounding boxes"},
        "extras":{"trivor":{"kind":"structure-overview","representedPrimitives":overview.represented,"aggregatedPrimitives":overview.aggregated}},
        "scene":0,"scenes":[{"nodes":(0..nodes.len()).collect::<Vec<_>>()}],"nodes":nodes,"meshes":meshes,"materials":materials,
        "buffers":[{"byteLength":bin.len()}],
        "bufferViews":[{"buffer":0,"byteOffset":0,"byteLength":288,"target":34962},{"buffer":0,"byteOffset":288,"byteLength":288,"target":34962},{"buffer":0,"byteOffset":576,"byteLength":72,"target":34963}],
        "accessors":[{"bufferView":0,"componentType":5126,"count":24,"type":"VEC3","min":[-0.5,-0.5,-0.5],"max":[0.5,0.5,0.5]},
            {"bufferView":1,"componentType":5126,"count":24,"type":"VEC3"},{"bufferView":2,"componentType":5123,"count":36,"type":"SCALAR"}]
    });
    let mut json = serde_json::to_vec(&doc).expect("bounded finite structure values");
    json.resize((json.len() + 3) & !3, b' ');
    let mut bytes = Vec::with_capacity(28 + json.len() + bin.len());
    bytes.extend_from_slice(b"glTF");
    bytes.extend_from_slice(&2u32.to_le_bytes());
    bytes.extend_from_slice(&((28 + json.len() + bin.len()) as u32).to_le_bytes());
    bytes.extend_from_slice(&(json.len() as u32).to_le_bytes());
    bytes.extend_from_slice(b"JSON");
    bytes.extend_from_slice(&json);
    bytes.extend_from_slice(&(bin.len() as u32).to_le_bytes());
    bytes.extend_from_slice(b"BIN\0");
    bytes.extend_from_slice(&bin);
    bytes
}

pub(crate) fn structure_preview_to_cache(
    source: &Path,
    cancelled: &AtomicBool,
) -> Result<PathBuf, LoadError> {
    check_cancelled(source, cancelled)?;
    let source = source
        .canonicalize()
        .map_err(|error| io_error(source, error))?;
    let metadata = source
        .metadata()
        .map_err(|error| io_error(&source, error))?;
    let mut hash = DefaultHasher::new();
    source.hash(&mut hash);
    metadata.len().hash(&mut hash);
    metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_nanos())
        .hash(&mut hash);
    let destination =
        crate::viewer_cache_dir().join(format!("structure-v1-{:016x}.glb", hash.finish()));
    if cache::valid_glb(&destination) {
        return Ok(destination);
    }
    let document = read_document(&source, cancelled)?;
    let overview = build_overview(&document, &source, cancelled)?;
    let bytes = encode_overview(&overview);
    check_cancelled(&source, cancelled)?;
    cache::write_atomic(&destination, |temporary| {
        let mut file = File::create(temporary).map_err(|error| io_error(temporary, error))?;
        file.write_all(&bytes)
            .map_err(|error| io_error(temporary, error))?;
        check_cancelled(&source, cancelled)
    })?;
    Ok(destination)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cache::tests::TempDir;
    use serde_json::Value;

    fn fixture() -> Value {
        json!({"asset":{"version":"2.0"},"scene":0,"scenes":[{"nodes":[0]}],"nodes":[{"mesh":0}],
            "meshes":[{"primitives":[{"attributes":{"POSITION":0},"material":0}]}],
            "accessors":[{"componentType":5126,"type":"VEC3","count":8,"min":[-1,-2,-3],"max":[1,2,3]}],
            "materials":[{"pbrMetallicRoughness":{"baseColorFactor":[0.8,0.2,0.1,1]}}]})
    }

    fn overview(value: Value) -> Result<Overview, LoadError> {
        let document: Document = serde_json::from_value(value).unwrap();
        build_overview(&document, Path::new("test.gltf"), &AtomicBool::new(false))
    }

    fn bounds(proxy: &ProxyBox) -> (Vec3, Vec3) {
        world_bounds(proxy.transform, Vec3::splat(-0.5), Vec3::splat(0.5)).unwrap()
    }

    #[test]
    fn repeated_mesh_instances_keep_parent_trs_and_column_major_matrix() {
        let mut value = fixture();
        value["nodes"] = json!([
            {"translation":[10,0,0],"children":[1,2]},
            {"mesh":0,"scale":[2,1,1]},
            {"mesh":0,"matrix":[1,0,0,0,0,1,0,0,0,0,1,0,0,20,0,1]}
        ]);
        let result = overview(value).unwrap();
        assert_eq!(result.boxes.len(), 2);
        assert_eq!(
            bounds(&result.boxes[0]),
            (Vec3::new(8.0, -2.0, -3.0), Vec3::new(12.0, 2.0, 3.0))
        );
        assert_eq!(
            bounds(&result.boxes[1]),
            (Vec3::new(9.0, 18.0, -3.0), Vec3::new(11.0, 22.0, 3.0))
        );
        assert_eq!(result.boxes[0].color, [0.8, 0.2, 0.1, 1.0]);
        let encoded = encode_overview(&result);
        gltf::Gltf::from_slice(&encoded).unwrap();
    }

    #[test]
    fn rotation_and_normalized_position_bounds_are_preserved() {
        let mut value = fixture();
        value["accessors"][0] =
            json!({"componentType":5123,"normalized":true,"min":[0,0,0],"max":[65535,65535,65535]});
        value["nodes"][0]["rotation"] = json!([
            0,
            0,
            std::f32::consts::FRAC_1_SQRT_2,
            std::f32::consts::FRAC_1_SQRT_2
        ]);
        let result = overview(value).unwrap();
        let (min, max) = bounds(&result.boxes[0]);
        assert!(min.abs_diff_eq(Vec3::new(-1.0, 0.0, 0.0), 1e-5));
        assert!(max.abs_diff_eq(Vec3::new(0.0, 1.0, 1.0), 1e-5));
    }

    #[test]
    fn iterative_walk_handles_deep_hierarchies_and_rejects_cycles() {
        let mut value = fixture();
        let mut nodes: Vec<Value> = (0..400)
            .map(|index| json!({"translation":[1,0,0],"children":[index+1]}))
            .collect();
        nodes.push(json!({"mesh":0}));
        value["nodes"] = json!(nodes);
        assert_eq!(
            bounds(&overview(value.clone()).unwrap().boxes[0]).0.x,
            399.0
        );
        value["nodes"][400]["children"] = json!([0]);
        assert!(overview(value).is_err());
    }

    #[test]
    fn box_budget_aggregates_remaining_geometry_instead_of_dropping_it() {
        let mut value = fixture();
        let count = MAX_BOXES + 17;
        value["nodes"] = json!((0..count)
            .map(|index| json!({"mesh":0,"translation":[index*10,0,0]}))
            .collect::<Vec<_>>());
        value["scenes"][0]["nodes"] = json!((0..count).collect::<Vec<_>>());
        let result = overview(value).unwrap();
        assert_eq!(result.boxes.len(), MAX_BOXES);
        assert_eq!(result.represented, count);
        assert_eq!(
            bounds(result.boxes.last().unwrap()).1.x,
            ((count - 1) * 10 + 1) as f32
        );
    }

    #[test]
    fn missing_bounds_and_excessive_depth_do_not_fabricate_success() {
        let mut value = fixture();
        value["accessors"][0].as_object_mut().unwrap().remove("min");
        assert!(overview(value).is_err());
        let mut value = fixture();
        let mut nodes: Vec<Value> = (0..MAX_DEPTH + 1)
            .map(|index| json!({"children":[index+1]}))
            .collect();
        nodes.push(json!({"mesh":0}));
        value["nodes"] = json!(nodes);
        assert!(overview(value).is_err());
    }

    #[test]
    fn gpu_instances_do_not_fabricate_an_untransformed_base_mesh_overview() {
        let mut value = fixture();
        value["nodes"][0]["extensions"] = json!({"EXT_mesh_gpu_instancing": {
            "attributes": {"TRANSLATION":1}
        }});
        value["accessors"].as_array_mut().unwrap().push(json!({
            "componentType":5126,"type":"VEC3","count":100,
            "min":[100,0,0],"max":[1000,50,20]
        }));
        assert!(
            matches!(overview(value), Err(LoadError::Parse { message, .. })
            if message == "MODEL_STRUCTURE_UNAVAILABLE")
        );
    }

    #[test]
    fn document_collection_limits_apply_during_deserialization() {
        let mut value = fixture();
        value["nodes"] = json!(vec![json!({}); MAX_NODES + 1]);
        assert!(serde_json::from_value::<Document>(value).is_err());
    }

    #[test]
    fn cancelled_preparation_and_malformed_json_are_rejected() {
        let dir = TempDir::new();
        let source = dir.0.join("model.gltf");
        std::fs::write(&source, serde_json::to_vec(&fixture()).unwrap()).unwrap();
        assert!(
            matches!(structure_preview_to_cache(&source,&AtomicBool::new(true)),Err(LoadError::Parse{message,..}) if message=="MODEL_PREPARATION_CANCELLED")
        );
        File::options()
            .write(true)
            .open(&source)
            .unwrap()
            .set_len(MAX_JSON_BYTES + 1)
            .unwrap();
        assert!(
            matches!(read_document(&source,&AtomicBool::new(false)),Err(LoadError::Parse{message,..}) if message=="MODEL_STRUCTURE_UNAVAILABLE")
        );
    }

    #[test]
    fn large_embedded_payload_is_scanned_without_losing_following_bounds() {
        let dir = TempDir::new();
        let source = dir.0.join("inline.gltf");
        let mut file = File::create(&source).unwrap();
        file.write_all(b"{\"buffers\":[{\"uri\":\"data:application/octet-stream;base64,")
            .unwrap();
        let chunk = [b'A'; 64 * 1024];
        for _ in 0..513 {
            file.write_all(&chunk).unwrap();
        }
        file.write_all(b"\",\"byteLength\":25214976}],").unwrap();
        let json = serde_json::to_vec(&fixture()).unwrap();
        file.write_all(&json[1..]).unwrap();
        let parsed = read_document(&source, &AtomicBool::new(false)).unwrap();
        let overview = build_overview(&parsed, &source, &AtomicBool::new(false)).unwrap();
        assert_eq!(overview.boxes.len(), 1);
        assert_eq!(bounds(&overview.boxes[0]).1, Vec3::new(1.0, 2.0, 3.0));
    }

    #[test]
    fn header_reader_never_requires_a_glb_binary_payload() {
        let dir = TempDir::new();
        let source = dir.0.join("header-only.glb");
        let mut json = serde_json::to_vec(&fixture()).unwrap();
        json.resize((json.len() + 3) & !3, b' ');
        let mut file = File::create(&source).unwrap();
        file.write_all(b"glTF").unwrap();
        file.write_all(&2u32.to_le_bytes()).unwrap();
        file.write_all(&((20 + json.len()) as u32).to_le_bytes())
            .unwrap();
        file.write_all(&(json.len() as u32).to_le_bytes()).unwrap();
        file.write_all(b"JSON").unwrap();
        file.write_all(&json).unwrap();
        let parsed = read_document(&source, &AtomicBool::new(false)).unwrap();
        assert_eq!(
            build_overview(&parsed, &source, &AtomicBool::new(false))
                .unwrap()
                .boxes
                .len(),
            1
        );
    }
}
