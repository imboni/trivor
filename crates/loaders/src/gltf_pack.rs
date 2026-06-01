//! Pack glTF / GLB for the webview viewer: embed sidecars, convert WebP → PNG,
//! and strip `EXT_texture_webp` (unsupported by model-viewer).

use std::borrow::Cow;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use base64::Engine;
use gltf::binary::Glb;
use gltf::json;
use gltf::json::validation::USize64;
use gltf::{buffer, Gltf};
use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::{ExtendedColorType, ImageEncoder, ImageFormat, RgbaImage};

use crate::gltf_inspect::{inspect_gltf_file, inspect_gltf_quick, needs_preview_optimize};
use crate::gltf_optimize::maybe_optimize_preview;
use crate::LoadError;
use crate::ProgressFn;

const EXT_TEXTURE_WEBP: &str = "EXT_texture_webp";

fn pad4(buf: &mut Vec<u8>) {
    while buf.len() % 4 != 0 {
        buf.push(0);
    }
}

fn parse_err(path: &Path, message: impl Into<String>) -> LoadError {
    LoadError::Parse {
        path: path.to_path_buf(),
        message: message.into(),
    }
}

fn read_uri_bytes(base: Option<&Path>, uri: &str, source: &Path) -> Result<Vec<u8>, LoadError> {
    if let Some(rest) = uri.strip_prefix("data:") {
        let b64 = rest
            .split_once(";base64,")
            .map(|(_, data)| data)
            .unwrap_or(rest);
        return base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|e| parse_err(source, format!("invalid data URI: {e}")));
    }
    let base = base.unwrap_or_else(|| Path::new("."));
    std::fs::read(base.join(uri)).map_err(|e| LoadError::Io {
        path: source.to_path_buf(),
        message: e.to_string(),
    })
}

fn read_encoded_image(
    image: &json::image::Image,
    buffer_views: &[json::buffer::View],
    buffers: &[buffer::Data],
    base: Option<&Path>,
    source: &Path,
) -> Result<Vec<u8>, LoadError> {
    if let Some(uri) = &image.uri {
        return read_uri_bytes(base, uri, source);
    }
    let bv_idx = image
        .buffer_view
        .ok_or_else(|| parse_err(source, "image has no uri or bufferView"))?;
    let bv = buffer_views
        .get(bv_idx.value() as usize)
        .ok_or_else(|| parse_err(source, "image bufferView index out of range"))?;
    let buf = buffers
        .get(bv.buffer.value() as usize)
        .ok_or_else(|| parse_err(source, "image buffer index out of range"))?;
    let off = bv.byte_offset.map(|o| o.0 as usize).unwrap_or(0);
    let len = bv.byte_length.0 as usize;
    if off + len > buf.0.len() {
        return Err(parse_err(source, "image bufferView out of range"));
    }
    Ok(buf.0[off..off + len].to_vec())
}

fn decode_rgba(encoded: &[u8], mime: Option<&str>, source: &Path) -> Result<RgbaImage, LoadError> {
    let format = match mime {
        Some("image/png") => ImageFormat::Png,
        Some("image/jpeg") | Some("image/jpg") => ImageFormat::Jpeg,
        Some("image/webp") => ImageFormat::WebP,
        _ => image::guess_format(encoded).map_err(|_| {
            parse_err(source, "unsupported or unknown texture encoding")
        })?,
    };
    let img = image::load_from_memory_with_format(encoded, format).map_err(|e| {
        parse_err(source, format!("failed to decode texture: {e}"))
    })?;
    Ok(img.to_rgba8())
}

fn encode_rgba_png(img: &RgbaImage, source: &Path) -> Result<Vec<u8>, LoadError> {
    let mut buf = Vec::new();
    let encoder = PngEncoder::new_with_quality(&mut buf, CompressionType::Fast, FilterType::NoFilter);
    encoder
        .write_image(img.as_raw(), img.width(), img.height(), ExtendedColorType::Rgba8)
        .map_err(|e| parse_err(source, format!("failed to encode texture: {e}")))?;
    Ok(buf)
}

fn report_progress(progress: Option<&ProgressFn<'_>>, pct: u8) {
    if let Some(f) = progress {
        f(pct.min(100));
    }
}

fn texture_source_is_empty(source: &json::Index<json::image::Image>) -> bool {
    source.value() == u32::MAX as usize
}

fn normalize_textures_for_viewer(root: &mut json::Root) {
    for tex in &mut root.textures {
        let webp_src = tex
            .extensions
            .as_mut()
            .and_then(|ext| ext.others.remove(EXT_TEXTURE_WEBP))
            .and_then(|v| v.get("source").and_then(|s| s.as_u64()));

        if let Some(src) = webp_src {
            tex.source = json::Index::new(src as u32);
        } else if texture_source_is_empty(&tex.source) {
            continue;
        }
    }
}

fn strip_gltf_extension(root: &mut json::Root, name: &str) {
    root.extensions_required.retain(|e| e != name);
    root.extensions_used.retain(|e| e != name);
}

fn image_mime(image: &json::image::Image) -> Option<String> {
    image.mime_type.as_ref().map(|m| m.0.clone())
}

fn image_needs_embed(image: &json::image::Image) -> bool {
    if image.uri.is_some() {
        return true;
    }
    image_mime(image).as_deref() == Some("image/webp")
}

fn open_for_pack(source: &Path) -> Result<(Gltf, Option<PathBuf>), LoadError> {
    let base = source.parent().map(Path::to_path_buf);
    let bytes = std::fs::read(source).map_err(|e| LoadError::Io {
        path: source.to_path_buf(),
        message: e.to_string(),
    })?;
    let gltf = Gltf::from_slice(&bytes).map_err(|e| LoadError::Parse {
        path: source.to_path_buf(),
        message: e.to_string(),
    })?;
    Ok((gltf, base))
}

fn needs_viewer_repack(source: &Path) -> Result<bool, LoadError> {
    let (gltf, _) = open_for_pack(source)?;
    let doc = &gltf.document;
    if doc
        .extensions_required()
        .any(|e| e == EXT_TEXTURE_WEBP)
    {
        return Ok(true);
    }
    if doc.extensions_used().any(|e| e == EXT_TEXTURE_WEBP) {
        return Ok(true);
    }
    for image in doc.images() {
        match image.source() {
            gltf::image::Source::View { mime_type, .. } if mime_type == "image/webp" => return Ok(true),
            gltf::image::Source::Uri { mime_type, uri } => {
                if mime_type == Some("image/webp") {
                    return Ok(true);
                }
                if uri.to_ascii_lowercase().ends_with(".webp") {
                    return Ok(true);
                }
            }
            _ => {}
        }
    }
    Ok(false)
}

fn pack_model_for_viewer(source: &Path, dest: &Path, progress: Option<&ProgressFn<'_>>) -> Result<(), LoadError> {
    report_progress(progress, 5);
    let (gltf, base) = open_for_pack(source)?;
    let base_ref = base.as_deref();
    let buffers = gltf::import_buffers(&gltf.document, base_ref, gltf.blob).map_err(|e| {
        LoadError::Parse {
            path: source.to_path_buf(),
            message: e.to_string(),
        }
    })?;
    report_progress(progress, 12);

    let mut root = gltf.document.into_json();
    normalize_textures_for_viewer(&mut root);
    strip_gltf_extension(&mut root, EXT_TEXTURE_WEBP);

    let mut bin: Vec<u8> = Vec::new();
    let mut buffer_offsets: Vec<usize> = Vec::with_capacity(buffers.len());

    for buf_data in &buffers {
        buffer_offsets.push(bin.len());
        bin.extend_from_slice(&buf_data.0);
        pad4(&mut bin);
    }

    for view in root.buffer_views.iter_mut() {
        let old_buf = view.buffer.value() as usize;
        let base_off = buffer_offsets.get(old_buf).copied().unwrap_or(0);
        let off = view.byte_offset.map(|o| o.0 as usize).unwrap_or(0);
        view.buffer = json::Index::new(0);
        view.byte_offset = Some(USize64((base_off + off) as u64));
    }

    let embed_indices: Vec<usize> = root
        .images
        .iter()
        .enumerate()
        .filter(|(_, image)| image_needs_embed(image))
        .map(|(i, _)| i)
        .collect();
    let total = embed_indices.len().max(1);
    let mut packed_images: Vec<(usize, Vec<u8>)> = Vec::with_capacity(embed_indices.len());

    for (n, &i) in embed_indices.iter().enumerate() {
        let image = &root.images[i];
        let mime = image_mime(image);
        let encoded = read_encoded_image(image, &root.buffer_views, &buffers, base_ref, source)?;
        let rgba = decode_rgba(&encoded, mime.as_deref(), source)?;
        let png = encode_rgba_png(&rgba, source)?;
        report_progress(progress, 12 + (((n + 1) * 73) / total) as u8);
        packed_images.push((i, png));
    }

    report_progress(progress, 88);

    let mut buffer_views = std::mem::take(&mut root.buffer_views);

    for (i, png) in packed_images {
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

        let image = &mut root.images[i];
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
    report_progress(progress, 94);

    let glb = Glb {
        header: gltf::binary::Header {
            magic: *b"glTF",
            version: 2,
            length: 0,
        },
        json: Cow::Owned(json_string.into_bytes()),
        bin: if bin.is_empty() {
            None
        } else {
            Some(Cow::Owned(bin))
        },
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

    report_progress(progress, 100);
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

fn pack_to_cache(source: &Path, progress: Option<&ProgressFn<'_>>) -> Result<PathBuf, LoadError> {
    let cache_dir = crate::viewer_cache_dir();
    std::fs::create_dir_all(&cache_dir).map_err(|e| LoadError::Io {
        path: cache_dir.clone(),
        message: e.to_string(),
    })?;

    let key = cache_key(source)?;
    let dest = cache_dir.join(format!("{key}.glb"));

    let needs_pack = match (std::fs::metadata(&dest), std::fs::metadata(source)) {
        (Ok(cached), Ok(src)) => match (cached.modified(), src.modified()) {
            (Ok(c), Ok(s)) => c < s,
            _ => true,
        },
        _ => true,
    };

    if needs_pack {
        pack_model_for_viewer(source, &dest, progress)?;
    } else {
        report_progress(progress, 100);
    }

    Ok(dest)
}

/// Path suitable for `convertFileSrc` + model-viewer (packed GLB when needed).
pub fn resolve_viewer_model(
    source: &Path,
    progress: Option<&ProgressFn<'_>>,
) -> Result<PathBuf, LoadError> {
    report_progress(progress, 0);
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

    match ext.as_str() {
        "gltf" => {
            let stats = inspect_gltf_file(&source)?;
            if needs_preview_optimize(&stats) {
                return maybe_optimize_preview(&source, &stats, progress);
            }
            pack_to_cache(&source, progress)
        }
        "glb" => {
            let stats = inspect_gltf_quick(&source)?;
            if needs_preview_optimize(&stats) {
                return maybe_optimize_preview(&source, &stats, progress);
            }
            if needs_viewer_repack(&source)? {
                pack_to_cache(&source, progress)
            } else {
                report_progress(progress, 100);
                Ok(source)
            }
        }
        _ => Err(LoadError::UnsupportedFormat(ext)),
    }
}
