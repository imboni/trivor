//! Pack separate `.gltf` + sidecar files into a single `.glb` for the webview viewer.
//! Avoids CORS / asset-protocol issues when model-viewer fetches `.bin` and textures.

use std::borrow::Cow;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use gltf::binary::Glb;
use gltf::image::Format;
use gltf::json;
use gltf::json::validation::USize64;
use image::{ImageFormat, RgbaImage};

use crate::LoadError;

fn pad4(buf: &mut Vec<u8>) {
    while buf.len() % 4 != 0 {
        buf.push(0);
    }
}

fn encode_image_png(data: &gltf::image::Data, path: &Path) -> Result<Vec<u8>, LoadError> {
    let rgba = match data.format {
        Format::R8G8B8A8 => data.pixels.clone(),
        Format::R8G8B8 => {
            let mut out = Vec::with_capacity(data.pixels.len() / 3 * 4);
            for chunk in data.pixels.chunks_exact(3) {
                out.extend_from_slice(&[chunk[0], chunk[1], chunk[2], 255]);
            }
            out
        }
        _ => {
            return Err(LoadError::Parse {
                path: path.to_path_buf(),
                message: "unsupported texture format in model".into(),
            });
        }
    };

    let img = RgbaImage::from_raw(data.width, data.height, rgba).ok_or_else(|| LoadError::Parse {
        path: path.to_path_buf(),
        message: "invalid image dimensions".into(),
    })?;

    let mut buf = Vec::new();
    img.write_to(&mut Cursor::new(&mut buf), ImageFormat::Png)
        .map_err(|e| LoadError::Parse {
            path: path.to_path_buf(),
            message: format!("failed to encode texture: {e}"),
        })?;
    Ok(buf)
}

fn pack_gltf_to_glb(source: &Path, dest: &Path) -> Result<(), LoadError> {
    let (document, buffers, images) = gltf::import(source).map_err(|e| LoadError::Parse {
        path: source.to_path_buf(),
        message: e.to_string(),
    })?;

    let mut root = document.into_json();
    let mut bin: Vec<u8> = Vec::new();
    let mut buffer_offsets: Vec<usize> = Vec::with_capacity(buffers.len());

    for buf_data in &buffers {
        buffer_offsets.push(bin.len());
        bin.extend_from_slice(&buf_data.0);
        pad4(&mut bin);
    }

    for view in root.buffer_views.iter_mut() {
        let old_buf = view.buffer.value() as usize;
        let base = buffer_offsets.get(old_buf).copied().unwrap_or(0);
        let off = view.byte_offset.map(|o| o.0 as usize).unwrap_or(0);
        view.buffer = json::Index::new(0);
        view.byte_offset = Some(USize64((base + off) as u64));
    }

    let mut buffer_views = std::mem::take(&mut root.buffer_views);

    for (i, image) in root.images.iter_mut().enumerate() {
        if image.buffer_view.is_some() {
            continue;
        }
        if image.uri.is_none() {
            continue;
        }
        let Some(img_data) = images.get(i) else {
            continue;
        };

        let png = encode_image_png(img_data, source)?;
        pad4(&mut bin);
        let byte_offset = bin.len();
        bin.extend_from_slice(&png);
        pad4(&mut bin);

        let bv_index = buffer_views.len();
        buffer_views.push(json::buffer::View {
            buffer: json::Index::new(0),
            byte_length: USize64(png.len() as u64),
            byte_offset: Some(USize64(byte_offset as u64)),
            byte_stride: None,
            name: None,
            target: None,
            extensions: None,
            extras: Default::default(),
        });

        image.buffer_view = Some(json::Index::new(bv_index as u32));
        image.uri = None;
        image.mime_type = Some(json::image::MimeType("image/png".into()));
    }

    root.buffer_views = buffer_views;
    root.buffers = vec![json::buffer::Buffer {
        byte_length: USize64(bin.len() as u64),
        uri: None,
        name: None,
        extensions: None,
        extras: Default::default(),
    }];

    let json_string = json::serialize::to_string(&root).map_err(|e| LoadError::Parse {
        path: source.to_path_buf(),
        message: format!("failed to serialize glTF: {e}"),
    })?;

    let glb = Glb {
        header: gltf::binary::Header {
            magic: *b"glTF",
            version: 2,
            length: 0,
        },
        json: Cow::Owned(json_string.into_bytes()),
        bin: if bin.is_empty() { None } else { Some(Cow::Owned(bin)) },
    };

    let bytes = glb.to_vec().map_err(|e| LoadError::Parse {
        path: source.to_path_buf(),
        message: format!("failed to build GLB: {e}"),
    })?;

    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| LoadError::Io {
            path: parent.to_path_buf(),
            message: e.to_string(),
        })?;
    }
    std::fs::write(dest, bytes).map_err(|e| LoadError::Io {
        path: dest.to_path_buf(),
        message: e.to_string(),
    })?;

    Ok(())
}

fn cache_key(source: &Path) -> Result<String, LoadError> {
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
    Ok(format!("{stem}-{mtime}"))
}

/// Path suitable for `convertFileSrc` + model-viewer (GLB, or packed GLB from glTF).
pub fn resolve_viewer_model(source: &Path) -> Result<PathBuf, LoadError> {
    let source = source
        .canonicalize()
        .map_err(|e| LoadError::Io {
            path: source.to_path_buf(),
            message: e.to_string(),
        })?;

    let ext = source
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();

    if ext == "glb" {
        return Ok(source);
    }

    if ext != "gltf" {
        return Err(LoadError::UnsupportedFormat(ext));
    }

    let cache_dir = crate::viewer_cache_dir();
    std::fs::create_dir_all(&cache_dir).map_err(|e| LoadError::Io {
        path: cache_dir.clone(),
        message: e.to_string(),
    })?;

    let key = cache_key(&source)?;
    let dest = cache_dir.join(format!("{key}.glb"));

    let needs_pack = match (std::fs::metadata(&dest), std::fs::metadata(&source)) {
        (Ok(cached), Ok(src)) => match (cached.modified(), src.modified()) {
            (Ok(c), Ok(s)) => c < s,
            _ => true,
        },
        _ => true,
    };

    if needs_pack {
        pack_gltf_to_glb(&source, &dest)?;
    }

    Ok(dest)
}
