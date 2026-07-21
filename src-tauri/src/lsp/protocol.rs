use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};

use percent_encoding::{percent_decode_str, utf8_percent_encode, AsciiSet, CONTROLS};
use serde_json::{json, Value};

const URI_PATH_ENCODE_SET: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'%')
    .add(b'<')
    .add(b'>')
    .add(b'?')
    .add(b'`')
    .add(b'{')
    .add(b'}');

pub(super) fn write_message(writer: &mut impl Write, message: &Value) -> Result<(), String> {
    let body = serde_json::to_vec(message)
        .map_err(|error| format!("Could not encode LSP message: {error}"))?;
    write!(writer, "Content-Length: {}\r\n\r\n", body.len())
        .and_then(|_| writer.write_all(&body))
        .and_then(|_| writer.flush())
        .map_err(|error| format!("Could not write LSP message: {error}"))
}

pub(super) fn read_message(reader: &mut impl BufRead) -> Result<Value, String> {
    let content_length = loop {
        let mut line = String::new();
        let read = reader
            .read_line(&mut line)
            .map_err(|error| format!("Could not read LSP header: {error}"))?;
        if read == 0 {
            return Err("The language server closed its output.".to_owned());
        }
        let line = line.trim_end_matches(['\r', '\n']);
        if let Some(value) = line
            .split_once(':')
            .filter(|(name, _)| name.eq_ignore_ascii_case("content-length"))
            .map(|(_, value)| value.trim())
        {
            let length = value
                .parse::<usize>()
                .map_err(|_| "The language server sent an invalid Content-Length.".to_owned())?;
            loop {
                let mut separator = String::new();
                let read = reader
                    .read_line(&mut separator)
                    .map_err(|error| format!("Could not finish LSP headers: {error}"))?;
                if read == 0 || separator == "\r\n" || separator == "\n" {
                    break;
                }
            }
            break length;
        }
    };
    if content_length > 8 * 1024 * 1024 {
        return Err("The language server sent a message larger than 8 MB.".to_owned());
    }
    let mut body = vec![0; content_length];
    reader
        .read_exact(&mut body)
        .map_err(|error| format!("Could not read LSP body: {error}"))?;
    serde_json::from_slice(&body).map_err(|error| format!("Invalid LSP JSON: {error}"))
}

pub(super) fn path_to_file_uri(path: &Path) -> Result<String, String> {
    let absolute = path
        .canonicalize()
        .map_err(|error| format!("Could not resolve {}: {error}", path.display()))?;
    let value = absolute.to_string_lossy();
    #[cfg(windows)]
    let value = value
        .strip_prefix(r"\\?\UNC\")
        .map(|value| format!("//{value}"))
        .or_else(|| value.strip_prefix(r"\\?\").map(str::to_owned))
        .unwrap_or_else(|| value.into_owned());
    #[cfg(not(windows))]
    let value = value.into_owned();
    let value = value.replace('\\', "/");
    let encoded = utf8_percent_encode(&value, URI_PATH_ENCODE_SET).to_string();
    if encoded.starts_with("//") {
        Ok(format!("file:{encoded}"))
    } else if encoded.starts_with('/') {
        Ok(format!("file://{encoded}"))
    } else {
        Ok(format!("file:///{encoded}"))
    }
}

pub(super) fn relative_path_from_uri(root: &Path, uri: &str) -> Result<String, String> {
    let raw = uri
        .strip_prefix("file://")
        .ok_or("The language server returned a non-file URI.")?;
    let decoded = percent_decode_str(raw)
        .decode_utf8()
        .map_err(|_| "The language server returned an invalid file URI.".to_owned())?;
    let decoded = decoded.as_ref();
    #[cfg(windows)]
    let decoded = if let Some(local) = decoded
        .strip_prefix('/')
        .filter(|value| value.as_bytes().get(1) == Some(&b':'))
    {
        local.replace('/', "\\")
    } else if !decoded.starts_with('/') {
        format!(r"\\{}", decoded.replace('/', "\\"))
    } else {
        decoded.replace('/', "\\")
    };
    #[cfg(not(windows))]
    let decoded = decoded.to_owned();
    let path = PathBuf::from(decoded)
        .canonicalize()
        .map_err(|error| format!("Could not resolve an LSP result path: {error}"))?;
    if !path.starts_with(root) {
        return Err("The language server returned a path outside the execution root.".to_owned());
    }
    Ok(path
        .strip_prefix(root)
        .unwrap_or(&path)
        .to_string_lossy()
        .replace('\\', "/"))
}

pub(super) fn normalize_location(root: &Path, value: &Value) -> Result<Value, String> {
    let uri = value
        .get("uri")
        .or_else(|| value.get("targetUri"))
        .and_then(Value::as_str)
        .ok_or("The language server returned a location without a URI.")?;
    let range = value
        .get("targetSelectionRange")
        .or_else(|| value.get("range"))
        .ok_or("The language server returned a location without a range.")?;
    let start = range
        .get("start")
        .ok_or("The language server returned a range without a start.")?;
    let end = range.get("end").unwrap_or(start);
    Ok(json!({
        "path": relative_path_from_uri(root, uri)?,
        "line": coordinate(start, "line")? + 1,
        "character": coordinate(start, "character")? + 1,
        "endLine": coordinate(end, "line")? + 1,
        "endCharacter": coordinate(end, "character")? + 1,
    }))
}

pub(super) fn normalize_locations(
    root: &Path,
    result: &Value,
    limit: usize,
) -> Result<Value, String> {
    if result.is_null() {
        return Ok(json!([]));
    }
    let values = result
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_else(|| std::slice::from_ref(result));
    let locations = values
        .iter()
        .take(limit)
        .map(|value| normalize_location(root, value))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Value::Array(locations))
}

fn coordinate(value: &Value, key: &str) -> Result<u64, String> {
    value
        .get(key)
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("The language server returned a range without `{key}`."))
}

pub(super) fn io_error(error: io::Error, action: &str) -> String {
    format!("Could not {action}: {error}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn lsp_framing_round_trips_json() {
        let expected = json!({ "jsonrpc": "2.0", "id": 4, "result": { "ok": true } });
        let mut bytes = Vec::new();
        write_message(&mut bytes, &expected).unwrap();
        let mut reader = Cursor::new(bytes);
        assert_eq!(read_message(&mut reader).unwrap(), expected);
    }

    #[test]
    fn lsp_reader_tolerates_a_noisy_process_preamble() {
        let body = br#"{"id":1,"result":null}"#;
        let framed = format!(
            "server startup banner\r\nContent-Length: {}\r\n\r\n{}",
            body.len(),
            String::from_utf8_lossy(body)
        );
        assert_eq!(
            read_message(&mut Cursor::new(framed.into_bytes())).unwrap(),
            json!({ "id": 1, "result": null })
        );
    }
}
