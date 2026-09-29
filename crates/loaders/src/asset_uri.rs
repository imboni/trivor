//! Resolve local glTF asset URIs without confusing URI escapes with file names.

use std::path::{Path, PathBuf};

use base64::Engine;

use crate::LoadError;

pub(crate) fn parse_error(source: &Path, message: impl Into<String>) -> LoadError {
    LoadError::Parse {
        path: source.to_path_buf(),
        message: message.into(),
    }
}

fn percent_decode(value: &str, source: &Path) -> Result<Vec<u8>, LoadError> {
    let mut bytes = Vec::with_capacity(value.len());
    let mut input = value.as_bytes().iter().copied();
    while let Some(byte) = input.next() {
        if byte == b'%' {
            let hex = |v: u8| (v as char).to_digit(16).map(|v| v as u8);
            let high = input.next().and_then(hex);
            let low = input.next().and_then(hex);
            match (high, low) {
                (Some(high), Some(low)) => bytes.push(high * 16 + low),
                _ => return Err(parse_error(source, "invalid percent escape in asset URI")),
            }
        } else {
            bytes.push(byte);
        }
    }
    Ok(bytes)
}

pub(crate) fn local_asset_path(source: &Path, uri: &str) -> Result<PathBuf, LoadError> {
    if uri.contains(':') || uri.starts_with("//") {
        return Err(parse_error(
            source,
            "only local relative asset URIs are supported",
        ));
    }
    let decoded = String::from_utf8(percent_decode(uri, source)?)
        .map_err(|_| parse_error(source, "asset URI is not UTF-8"))?;
    Ok(source
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(decoded))
}

pub(crate) fn read_asset(source: &Path, uri: &str) -> Result<Vec<u8>, LoadError> {
    if let Some(data) = uri.strip_prefix("data:") {
        let (header, payload) = data
            .split_once(',')
            .ok_or_else(|| parse_error(source, "invalid data URI"))?;
        let decoded = percent_decode(payload, source)?;
        return if header.ends_with(";base64") {
            base64::engine::general_purpose::STANDARD
                .decode(decoded)
                .map_err(|e| parse_error(source, format!("invalid data URI: {e}")))
        } else {
            Ok(decoded)
        };
    }
    let path = local_asset_path(source, uri)?;
    std::fs::read(&path).map_err(|e| LoadError::Io {
        path,
        message: e.to_string(),
    })
}
