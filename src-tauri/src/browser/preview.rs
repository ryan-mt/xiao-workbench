use std::collections::VecDeque;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};

use percent_encoding::{percent_decode_str, utf8_percent_encode, NON_ALPHANUMERIC};
use tauri::http::{header, Request, Response, StatusCode};

const MAX_PREVIEW_ROOTS: usize = 16;

#[derive(Clone, Default)]
pub struct PreviewRegistry {
    roots: Arc<Mutex<VecDeque<(String, PathBuf)>>>,
}

impl PreviewRegistry {
    pub fn register(&self, root: PathBuf, relative_path: &Path) -> Result<String, String> {
        let token = uuid::Uuid::now_v7().to_string();
        let mut roots = self
            .roots
            .lock()
            .map_err(|_| "Workspace preview registry is unavailable.".to_owned())?;
        roots.push_back((token.clone(), root));
        while roots.len() > MAX_PREVIEW_ROOTS {
            roots.pop_front();
        }

        let encoded_path = relative_path
            .components()
            .filter_map(|component| match component {
                Component::Normal(value) => value.to_str(),
                _ => None,
            })
            .map(|segment| utf8_percent_encode(segment, NON_ALPHANUMERIC).to_string())
            .collect::<Vec<_>>()
            .join("/");

        #[cfg(any(target_os = "windows", target_os = "android"))]
        return Ok(format!(
            "http://xiao-preview.localhost/{token}/{encoded_path}"
        ));

        #[cfg(not(any(target_os = "windows", target_os = "android")))]
        Ok(format!("xiao-preview://localhost/{token}/{encoded_path}"))
    }

    pub fn respond(&self, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
        match self.read_request(request) {
            Ok((bytes, content_type)) => Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, content_type)
                .header(header::CACHE_CONTROL, "no-store")
                .body(bytes)
                .unwrap_or_else(|_| internal_error()),
            Err((status, message)) => Response::builder()
                .status(status)
                .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
                .body(message.into_bytes())
                .unwrap_or_else(|_| internal_error()),
        }
    }

    fn read_request(
        &self,
        request: &Request<Vec<u8>>,
    ) -> Result<(Vec<u8>, &'static str), (StatusCode, String)> {
        let decoded = percent_decode_str(request.uri().path())
            .decode_utf8()
            .map_err(|_| (StatusCode::BAD_REQUEST, "Invalid preview path.".to_owned()))?;
        let mut components = Path::new(decoded.trim_start_matches('/')).components();
        let token = match components.next() {
            Some(Component::Normal(value)) => value.to_string_lossy().into_owned(),
            _ => return Err((StatusCode::BAD_REQUEST, "Invalid preview token.".to_owned())),
        };
        let relative = components.collect::<PathBuf>();
        if relative.as_os_str().is_empty()
            || relative.components().any(|component| {
                matches!(
                    component,
                    Component::ParentDir | Component::RootDir | Component::Prefix(_)
                )
            })
        {
            return Err((
                StatusCode::BAD_REQUEST,
                "Preview path must stay inside the workspace.".to_owned(),
            ));
        }

        let root = self
            .roots
            .lock()
            .map_err(|_| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Workspace preview registry is unavailable.".to_owned(),
                )
            })?
            .iter()
            .find_map(|(registered_token, root)| {
                (registered_token == &token).then(|| root.clone())
            })
            .ok_or_else(|| {
                (
                    StatusCode::NOT_FOUND,
                    "This workspace preview has expired.".to_owned(),
                )
            })?;

        let requested = root.join(relative);
        let requested = requested.canonicalize().map_err(|_| {
            (
                StatusCode::NOT_FOUND,
                "Preview resource was not found.".to_owned(),
            )
        })?;
        if !requested.starts_with(&root) || !requested.is_file() {
            return Err((
                StatusCode::FORBIDDEN,
                "Preview resource must stay inside the workspace.".to_owned(),
            ));
        }
        let bytes = fs::read(&requested).map_err(|error| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Could not read preview resource: {error}"),
            )
        })?;
        Ok((bytes, content_type(&requested)))
    }
}

fn content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        _ => "application/octet-stream",
    }
}

fn internal_error() -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::INTERNAL_SERVER_ERROR)
        .body(b"Could not build preview response.".to_vec())
        .expect("static preview response is valid")
}

#[cfg(test)]
mod tests {
    use super::{content_type, PreviewRegistry};
    use std::fs;
    use std::path::Path;
    use tauri::http::{Request, StatusCode};

    #[test]
    fn serves_browser_assets_with_explicit_content_types() {
        assert_eq!(content_type(Path::new("index.html")), "text/html; charset=utf-8");
        assert_eq!(content_type(Path::new("styles.css")), "text/css; charset=utf-8");
        assert_eq!(content_type(Path::new("app.js")), "text/javascript; charset=utf-8");
        assert_eq!(content_type(Path::new("photo.png")), "image/png");
    }

    #[test]
    fn serves_registered_workspace_files_and_blocks_parent_traversal() {
        let directory = std::env::temp_dir().join(format!(
            "xiao-preview-test-{}",
            uuid::Uuid::now_v7()
        ));
        let root = directory.join("workspace");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("index.html"), b"<h1>Preview</h1>").unwrap();
        fs::write(directory.join("secret.txt"), b"secret").unwrap();
        let root = root.canonicalize().unwrap();
        let registry = PreviewRegistry::default();
        let url = registry.register(root, Path::new("index.html")).unwrap();
        let parsed = tauri::Url::parse(&url).unwrap();
        let request = Request::builder()
            .uri(parsed.path())
            .body(Vec::new())
            .unwrap();
        let response = registry.respond(&request);
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.body(), b"<h1>Preview</h1>");

        let token = parsed.path().trim_start_matches('/').split('/').next().unwrap();
        let traversal = Request::builder()
            .uri(format!("/{token}/%2E%2E/secret.txt"))
            .body(Vec::new())
            .unwrap();
        assert_eq!(registry.respond(&traversal).status(), StatusCode::BAD_REQUEST);
        fs::remove_dir_all(directory).unwrap();
    }
}
