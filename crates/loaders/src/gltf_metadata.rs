//! Bounded JSON metadata reads. Inline base64 payloads are scanned, never retained.
use std::io::{self, BufReader, Read};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::de::DeserializeOwned;

use crate::{model_assets::io_error, LoadError};

const JSON_LIMIT: usize = 32 * 1024 * 1024;
const DATA_PREFIX_LIMIT: usize = 4096;

/// Keep a short data URI prefix for image headers while skipping the payload. This
/// reader is only for metadata/dependency discovery, never for import or export.
struct MetadataReader<'a, R> {
    cancelled: Option<&'a AtomicBool>,
    input: R,
    quoted: bool,
    escaped: bool,
    escape_remaining: usize,
    prefix: Vec<u8>,
    string_len: usize,
    is_data: bool,
    emitted: usize,
}

impl<R: Read> Read for MetadataReader<'_, R> {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        if out.is_empty() {
            return Ok(0);
        }
        let mut input = vec![0; out.len().min(64 * 1024)];
        loop {
            if self
                .cancelled
                .is_some_and(|flag| flag.load(Ordering::Relaxed))
            {
                return Err(io::Error::new(
                    io::ErrorKind::Other,
                    "MODEL_PREPARATION_CANCELLED",
                ));
            }
            let len = self.input.read(&mut input)?;
            if len == 0 {
                return Ok(0);
            }
            let mut written = 0;
            for &byte in &input[..len] {
                let was_escaped = self.escaped;
                let closing = self.quoted && !was_escaped && byte == b'"';
                let keep = !self.quoted
                    || closing
                    || !self.is_data
                    || self.string_len < DATA_PREFIX_LIMIT
                    || self.escape_remaining != 0;
                if keep {
                    out[written] = byte;
                    written += 1;
                    self.emitted += 1;
                    if self.emitted > JSON_LIMIT {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            "glTF metadata exceeds 32 MiB",
                        ));
                    }
                }
                if !self.quoted {
                    if byte == b'"' {
                        self.quoted = true;
                        self.escaped = false;
                        self.prefix.clear();
                        self.string_len = 0;
                        self.is_data = false;
                    }
                } else if closing {
                    self.quoted = false;
                    self.escaped = false;
                } else {
                    if self.prefix.len() < 5 {
                        self.prefix.push(byte);
                        self.is_data = self.prefix == b"data:";
                    }
                    self.string_len += 1;
                    if was_escaped && byte == b'u' && self.escape_remaining != 0 {
                        self.escape_remaining = 4;
                    } else if keep && !was_escaped && byte == b'\\' {
                        self.escape_remaining = 1;
                    } else {
                        self.escape_remaining = self.escape_remaining.saturating_sub(1);
                    }
                    self.escaped = !was_escaped && byte == b'\\';
                }
            }
            if written != 0 {
                return Ok(written);
            }
        }
    }
}

pub(crate) fn read<T: DeserializeOwned>(path: &Path) -> Result<T, LoadError> {
    read_inner(path, None)
}

pub(crate) fn read_cancellable<T: DeserializeOwned>(
    path: &Path,
    cancelled: &AtomicBool,
) -> Result<T, LoadError> {
    read_inner(path, Some(cancelled))
}

fn read_inner<T: DeserializeOwned>(
    path: &Path,
    cancelled: Option<&AtomicBool>,
) -> Result<T, LoadError> {
    if cancelled.is_some_and(|flag| flag.load(Ordering::Relaxed)) {
        return Err(crate::asset_uri::parse_error(
            path,
            "MODEL_PREPARATION_CANCELLED",
        ));
    }
    let result = if path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("gltf"))
    {
        let file = std::fs::File::open(path).map_err(|e| io_error(path, e))?;
        let input = MetadataReader {
            cancelled,
            input: BufReader::with_capacity(64 * 1024, file),
            quoted: false,
            escaped: false,
            escape_remaining: 0,
            prefix: Vec::with_capacity(5),
            string_len: 0,
            is_data: false,
            emitted: 0,
        };
        serde_json::from_reader(BufReader::with_capacity(64 * 1024, input))
    } else {
        serde_json::from_slice(&crate::gltf_inspect::read_gltf_json_bytes(path)?)
    };
    if cancelled.is_some_and(|flag| flag.load(Ordering::Relaxed)) {
        return Err(crate::asset_uri::parse_error(
            path,
            "MODEL_PREPARATION_CANCELLED",
        ));
    }
    result.map_err(|e| {
        crate::asset_uri::parse_error(path, format!("failed to parse glTF metadata: {e}"))
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn scans_inline_payload_without_retaining_it_and_keeps_following_fields() {
        let dir = crate::cache::tests::TempDir::new();
        let path = dir.0.join("inline.gltf");
        std::fs::write(&path, format!("{{\"buffers\":[{{\"uri\":\"data:application/octet-stream;base64,{}\",\"byteLength\":5000000}}],\"asset\":{{\"version\":\"2.0\"}}}}", "A".repeat(7_000_000))).unwrap();
        let doc: serde_json::Value = super::read(&path).unwrap();
        assert!(doc["buffers"][0]["uri"].as_str().unwrap().len() <= 4096);
        assert_eq!(doc["buffers"][0]["byteLength"], 5_000_000);
        assert_eq!(doc["asset"]["version"], "2.0");
    }
    #[test]
    fn inline_prefix_cutoff_keeps_entire_json_escape() {
        let dir = crate::cache::tests::TempDir::new();
        let path = dir.0.join("escaped.gltf");
        for escape in [r"\/", r"\u002f"] {
            let prefix = format!(
                "data:;base64,{}",
                "A".repeat(super::DATA_PREFIX_LIMIT - 1 - "data:;base64,".len())
            );
            let raw = format!(
                r#"{{"buffers":[{{"uri":"{prefix}{escape}{}","byteLength":9000}}],"asset":{{"version":"2.0"}}}}"#,
                r#"\/\"\u0041"#.repeat(8000)
            );
            std::fs::write(&path, raw).unwrap();
            let doc: serde_json::Value = super::read(&path).unwrap();
            assert_eq!(doc["asset"]["version"], "2.0");
            assert!(doc["buffers"][0]["uri"].as_str().unwrap().ends_with('/'));
        }
    }

    #[test]
    fn cancelled_metadata_and_access_checks_do_not_read_the_source() {
        let cancelled = std::sync::atomic::AtomicBool::new(true);
        let source = std::path::Path::new("missing-model.gltf");
        let error = super::read_cancellable::<serde_json::Value>(source, &cancelled).unwrap_err();
        assert!(error.to_string().contains("MODEL_PREPARATION_CANCELLED"));
        let error =
            crate::ensure_model_assets_readable_cancellable(source, &cancelled).unwrap_err();
        assert!(error.to_string().contains("MODEL_PREPARATION_CANCELLED"));
        let error = crate::load_scene_summary_cancellable(source, &cancelled, None).unwrap_err();
        assert!(error.to_string().contains("MODEL_PREPARATION_CANCELLED"));
    }
}
