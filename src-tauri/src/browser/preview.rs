use std::collections::{HashMap, VecDeque};
use std::fs;
use std::net::IpAddr;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use percent_encoding::{percent_decode_str, utf8_percent_encode, NON_ALPHANUMERIC};
use tauri::http::{header, Request, Response, StatusCode};

const MAX_PREVIEW_ROOTS: usize = 16;
const HISTORY_NAVIGATION_ALLOWANCE_TTL: Duration = Duration::from_secs(2);
const MAIN_WEBVIEW_LABEL: &str = "main";
const TASK_PREVIEW_LABEL_PREFIX: &str = "xiao-task-preview-";
const PREVIEW_CONTENT_SECURITY_POLICY: &str = concat!(
    "default-src 'none'; ",
    "script-src 'self'; ",
    "style-src 'self' 'unsafe-inline'; ",
    "img-src 'self' data: blob:; ",
    "font-src 'self' data:; ",
    "media-src 'self' blob:; ",
    "connect-src 'self'; ",
    "worker-src 'self' blob:; ",
    "manifest-src 'self'; ",
    "object-src 'none'; ",
    "base-uri 'none'; ",
    "form-action 'none'; ",
    "frame-src 'none'; ",
    "frame-ancestors 'none'; ",
    "navigate-to 'self'; ",
    "sandbox allow-scripts allow-same-origin"
);

#[derive(Clone)]
enum NavigationAllowance {
    Exact(String),
    HistoryTraversal(Instant),
}

#[derive(Clone, Default)]
pub struct PreviewRegistry {
    roots: Arc<Mutex<VecDeque<(String, PathBuf, Option<PreviewScope>)>>>,
    navigation_allowances: Arc<Mutex<HashMap<String, NavigationAllowance>>>,
    webview_tasks: Arc<Mutex<HashMap<String, PreviewScope>>>,
    registered_origins: Arc<Mutex<HashMap<String, Vec<String>>>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PreviewScope {
    pub project_path: String,
    pub task_id: String,
    pub execution_root: String,
}

impl PreviewRegistry {
    pub fn register(
        &self,
        root: PathBuf,
        relative_path: &Path,
        scope: Option<PreviewScope>,
    ) -> Result<String, String> {
        let token = uuid::Uuid::now_v7().to_string();
        let mut roots = self
            .roots
            .lock()
            .map_err(|_| "Workspace preview registry is unavailable.".to_owned())?;
        roots.push_back((token.clone(), root, scope));
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
        return Ok(format!("http://xiao-preview.{token}/{encoded_path}"));

        #[cfg(not(any(target_os = "windows", target_os = "android")))]
        Ok(format!("xiao-preview://{token}/{encoded_path}"))
    }

    pub(crate) fn register_task_preview_target(
        &self,
        webview_label: &str,
        scope: PreviewScope,
        target: &tauri::Url,
    ) -> Result<(), String> {
        let registered = preview_token(target)
            .is_some_and(|token| self.token_belongs_to_scope(token, &scope))
            || is_loopback_http_url(target);
        if !registered {
            return Err("Task Preview target is not registered for this Task.".to_owned());
        }
        if let Ok(mut bindings) = self.webview_tasks.lock() {
            bindings.insert(webview_label.to_owned(), scope);
        }
        if let Some(origin) = url_origin(target) {
            let mut origins = self
                .registered_origins
                .lock()
                .map_err(|_| "Task Preview registry is unavailable.".to_owned())?;
            let registered = origins.entry(webview_label.to_owned()).or_default();
            if !registered.contains(&origin) {
                registered.push(origin);
            }
        }
        Ok(())
    }

    pub(crate) fn task_preview_scope_matches(
        &self,
        webview_label: &str,
        scope: &PreviewScope,
    ) -> bool {
        self.webview_tasks
            .lock()
            .ok()
            .is_some_and(|bindings| bindings.get(webview_label) == Some(scope))
    }

    pub(crate) fn task_preview_targets(&self, scope: &PreviewScope) -> Vec<(String, Vec<String>)> {
        let Ok(bindings) = self.webview_tasks.lock() else {
            return Vec::new();
        };
        let Ok(origins) = self.registered_origins.lock() else {
            return Vec::new();
        };
        let mut targets = bindings
            .iter()
            .filter(|(_, binding)| *binding == scope)
            .map(|(label, _)| {
                (
                    label.clone(),
                    origins.get(label).cloned().unwrap_or_default(),
                )
            })
            .collect::<Vec<_>>();
        targets.sort_by(|left, right| left.0.cmp(&right.0));
        targets
    }

    pub(crate) fn allow_navigation(&self, webview_label: &str, target: &tauri::Url) {
        if let Ok(mut allowances) = self.navigation_allowances.lock() {
            allowances.insert(
                webview_label.to_owned(),
                NavigationAllowance::Exact(target.to_string()),
            );
        }
    }

    pub(crate) fn allow_history_navigation(&self, webview_label: &str) {
        if let Ok(mut allowances) = self.navigation_allowances.lock() {
            allowances.insert(
                webview_label.to_owned(),
                NavigationAllowance::HistoryTraversal(
                    Instant::now() + HISTORY_NAVIGATION_ALLOWANCE_TTL,
                ),
            );
        }
    }

    pub(crate) fn clear_navigation_allowance(&self, webview_label: &str) {
        if let Ok(mut allowances) = self.navigation_allowances.lock() {
            allowances.remove(webview_label);
        }
    }

    pub(crate) fn navigation_allowed(
        &self,
        webview_label: &str,
        current: &tauri::Url,
        target: &tauri::Url,
    ) -> bool {
        if webview_label == MAIN_WEBVIEW_LABEL {
            return main_app_navigation_allowed(current, target);
        }
        if webview_label != "xiao-game"
            && !webview_label
                .strip_prefix(TASK_PREVIEW_LABEL_PREFIX)
                .is_some_and(|task| {
                    !task.is_empty()
                        && task.len() <= 72
                        && task
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
                })
        {
            return false;
        }
        if !matches!(target.scheme(), "http" | "https" | "xiao-preview") {
            self.clear_navigation_allowance(webview_label);
            return false;
        }
        let task_preview = webview_label.starts_with(TASK_PREVIEW_LABEL_PREFIX);
        let allowance = self
            .navigation_allowances
            .lock()
            .ok()
            .and_then(|mut allowances| allowances.remove(webview_label));
        let explicitly_allowed = matches!(
            &allowance,
            Some(NavigationAllowance::Exact(allowed)) if allowed == target.as_str()
        );
        let history_allowed = matches!(
            allowance,
            Some(NavigationAllowance::HistoryTraversal(expires_at)) if Instant::now() <= expires_at
        );
        if task_preview {
            let scope = self
                .webview_tasks
                .lock()
                .ok()
                .and_then(|bindings| bindings.get(webview_label).cloned());
            let registered_target = scope.as_ref().is_some_and(|scope| {
                preview_token(target).is_some_and(|token| self.token_belongs_to_scope(token, scope))
            }) || url_origin(target).is_some_and(|origin| {
                self.registered_origins.lock().ok().is_some_and(|origins| {
                    origins
                        .get(webview_label)
                        .is_some_and(|registered| registered.contains(&origin))
                })
            });
            return registered_target
                && (explicitly_allowed || history_allowed || same_origin(current, target));
        }
        if preview_token(current).is_none() {
            return true;
        }
        preview_token(target).is_some_and(|token| self.contains_token(token))
            || explicitly_allowed
            || history_allowed
    }

    pub fn respond(&self, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
        match self.read_request(request) {
            Ok((bytes, content_type)) => Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, content_type)
                .header(header::CACHE_CONTROL, "no-store")
                .header(
                    header::CONTENT_SECURITY_POLICY,
                    PREVIEW_CONTENT_SECURITY_POLICY,
                )
                .header("X-Content-Type-Options", "nosniff")
                .header("Referrer-Policy", "no-referrer")
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
        let relative = Path::new(decoded.trim_start_matches('/'));
        if relative.as_os_str().is_empty()
            || relative
                .components()
                .any(|component| !matches!(component, Component::Normal(_)))
        {
            return Err((
                StatusCode::BAD_REQUEST,
                "Preview path must stay inside the preview root.".to_owned(),
            ));
        }
        let token = request_preview_token(request).ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                "This workspace preview has expired.".to_owned(),
            )
        })?;
        let root = self.root_for_token(token).ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                "This workspace preview has expired.".to_owned(),
            )
        })?;
        if !safe_preview_asset_path(relative) {
            return Err((
                StatusCode::FORBIDDEN,
                "Preview resource type is not allowed.".to_owned(),
            ));
        }

        let requested = root.join(relative);
        let requested = requested.canonicalize().map_err(|_| {
            (
                StatusCode::NOT_FOUND,
                "Preview resource was not found.".to_owned(),
            )
        })?;
        let canonical_relative = requested.strip_prefix(&root).map_err(|_| {
            (
                StatusCode::FORBIDDEN,
                "Preview resource must stay inside the preview root.".to_owned(),
            )
        })?;
        if !requested.is_file() || !safe_preview_asset_path(canonical_relative) {
            return Err((
                StatusCode::FORBIDDEN,
                "Preview resource type is not allowed.".to_owned(),
            ));
        }
        let bytes = fs::read(&requested).map_err(|error| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Could not read preview resource: {error}"),
            )
        })?;
        let content_type = content_type(&requested).ok_or_else(|| {
            (
                StatusCode::FORBIDDEN,
                "Preview resource type is not allowed.".to_owned(),
            )
        })?;
        Ok((bytes, content_type))
    }

    fn root_for_token(&self, token: &str) -> Option<PathBuf> {
        self.roots
            .lock()
            .ok()?
            .iter()
            .find_map(|(registered, root, _)| (registered == token).then(|| root.clone()))
    }

    fn contains_token(&self, token: &str) -> bool {
        self.roots
            .lock()
            .is_ok_and(|roots| roots.iter().any(|(registered, _, _)| registered == token))
    }

    fn token_belongs_to_scope(&self, token: &str, scope: &PreviewScope) -> bool {
        self.roots.lock().is_ok_and(|roots| {
            roots
                .iter()
                .any(|(registered, _, owner)| registered == token && owner.as_ref() == Some(scope))
        })
    }
}

pub(crate) fn is_loopback_http_url(url: &tauri::Url) -> bool {
    matches!(url.scheme(), "http" | "https")
        && url.host_str().is_some_and(|host| {
            host.eq_ignore_ascii_case("localhost")
                || host
                    .parse::<IpAddr>()
                    .is_ok_and(|address| address.is_loopback())
        })
}

fn same_origin(left: &tauri::Url, right: &tauri::Url) -> bool {
    left.scheme() == right.scheme()
        && left.host_str() == right.host_str()
        && left.port_or_known_default() == right.port_or_known_default()
}

fn url_origin(url: &tauri::Url) -> Option<String> {
    url.host_str().map(|host| {
        format!(
            "{}://{}:{}",
            url.scheme(),
            host,
            url.port_or_known_default().unwrap_or_default()
        )
    })
}

fn main_app_navigation_allowed(current: &tauri::Url, target: &tauri::Url) -> bool {
    if !is_main_app_url(target) {
        return false;
    }
    current.as_str() == "about:blank"
        || (current.scheme() == target.scheme()
            && current.host_str() == target.host_str()
            && current.port_or_known_default() == target.port_or_known_default())
}

fn is_main_app_url(url: &tauri::Url) -> bool {
    match (url.scheme(), url.host_str(), url.port()) {
        ("tauri", Some("localhost"), None) => true,
        ("http" | "https", Some("tauri.localhost"), None) => true,
        ("http", Some("127.0.0.1"), Some(1420)) if cfg!(debug_assertions) => true,
        _ => false,
    }
}

fn request_preview_token(request: &Request<Vec<u8>>) -> Option<&str> {
    let host = request.uri().host()?;
    if request.uri().scheme_str() == Some("xiao-preview") {
        valid_preview_token(host)
    } else {
        valid_preview_token(host.strip_prefix("xiao-preview.")?)
    }
}

pub(crate) fn is_preview_url(url: &tauri::Url) -> bool {
    preview_token(url).is_some()
}

fn preview_token(url: &tauri::Url) -> Option<&str> {
    let host = url.host_str()?;
    if url.scheme() == "xiao-preview" {
        valid_preview_token(host)
    } else if matches!(url.scheme(), "http" | "https") {
        valid_preview_token(host.strip_prefix("xiao-preview.")?)
    } else {
        None
    }
}

fn valid_preview_token(token: &str) -> Option<&str> {
    uuid::Uuid::parse_str(token).is_ok().then_some(token)
}

fn safe_preview_asset_path(path: &Path) -> bool {
    path.components().all(|component| match component {
        Component::Normal(value) => value
            .to_str()
            .is_some_and(|value| !value.starts_with('.') && !value.contains('\0')),
        _ => false,
    }) && content_type(path).is_some()
}

fn content_type(path: &Path) -> Option<&'static str> {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "html" | "htm" => Some("text/html; charset=utf-8"),
        "css" => Some("text/css; charset=utf-8"),
        "js" | "mjs" => Some("text/javascript; charset=utf-8"),
        "svg" => Some("image/svg+xml"),
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "ico" => Some("image/x-icon"),
        "woff" => Some("font/woff"),
        "woff2" => Some("font/woff2"),
        "ttf" => Some("font/ttf"),
        "mp4" => Some("video/mp4"),
        "webm" => Some("video/webm"),
        "mp3" => Some("audio/mpeg"),
        "wav" => Some("audio/wav"),
        _ => None,
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
    use super::{
        content_type, NavigationAllowance, PreviewRegistry, PreviewScope,
        PREVIEW_CONTENT_SECURITY_POLICY,
    };
    use std::fs;
    use std::path::Path;
    use std::time::{Duration, Instant};
    use tauri::http::{header, Request, StatusCode};
    use tauri::Url;

    fn scope(task_id: &str) -> PreviewScope {
        PreviewScope {
            project_path: "C:\\project".to_owned(),
            task_id: task_id.to_owned(),
            execution_root: "C:\\project\\.xiao-worktree".to_owned(),
        }
    }

    #[test]
    fn preview_webviews_have_no_native_command_capability() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../../capabilities/default.json")).unwrap();
        assert_eq!(capability["webviews"], serde_json::json!(["main"]));
        assert!(capability.get("windows").is_none());
        assert!(capability["permissions"]
            .as_array()
            .unwrap()
            .contains(&serde_json::json!("main-commands")));
    }

    #[test]
    fn serves_browser_assets_with_explicit_content_types() {
        assert_eq!(
            content_type(Path::new("index.html")),
            Some("text/html; charset=utf-8")
        );
        assert_eq!(
            content_type(Path::new("styles.css")),
            Some("text/css; charset=utf-8")
        );
        assert_eq!(
            content_type(Path::new("app.js")),
            Some("text/javascript; charset=utf-8")
        );
        assert_eq!(content_type(Path::new("photo.png")), Some("image/png"));
        assert_eq!(content_type(Path::new("source.rs")), None);
    }

    #[test]
    fn serves_registered_workspace_files_and_blocks_parent_traversal() {
        let directory =
            std::env::temp_dir().join(format!("xiao-preview-test-{}", uuid::Uuid::now_v7()));
        let root = directory.join("workspace");
        fs::create_dir_all(root.join("assets")).unwrap();
        fs::write(root.join("index.html"), b"<h1>Preview</h1>").unwrap();
        fs::write(root.join("assets/app.js"), b"console.log('preview')").unwrap();
        fs::write(root.join(".env"), b"private").unwrap();
        fs::write(root.join("source.rs"), b"fn private() {}").unwrap();
        fs::write(directory.join("secret.txt"), b"secret").unwrap();
        let registry = PreviewRegistry::default();
        let url = registry
            .register(
                root.canonicalize().unwrap(),
                Path::new("index.html"),
                Some(scope("task")),
            )
            .unwrap();
        let parsed = tauri::Url::parse(&url).unwrap();
        let token = super::preview_token(&parsed).unwrap();
        let request = protocol_request(token, "/index.html");
        let response = registry.respond(&request);
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.body(), b"<h1>Preview</h1>");
        assert_eq!(
            response
                .headers()
                .get(header::CONTENT_SECURITY_POLICY)
                .unwrap(),
            PREVIEW_CONTENT_SECURITY_POLICY,
        );

        assert_eq!(
            registry
                .respond(&protocol_request(token, "/%2E%2E/secret.txt"))
                .status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            registry
                .respond(&protocol_request(token, "/assets/app.js"))
                .status(),
            StatusCode::OK
        );
        assert_eq!(
            registry.respond(&protocol_request(token, "/.env")).status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            registry
                .respond(&protocol_request(token, "/source.rs"))
                .status(),
            StatusCode::FORBIDDEN
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn isolates_root_relative_assets_by_preview_origin() {
        let directory =
            std::env::temp_dir().join(format!("xiao-preview-origins-{}", uuid::Uuid::now_v7()));
        let first = directory.join("first");
        let second = directory.join("second");
        for (root, contents) in [
            (&first, b"first".as_slice()),
            (&second, b"second".as_slice()),
        ] {
            fs::create_dir_all(root.join("assets")).unwrap();
            fs::write(root.join("index.html"), b"<h1>Preview</h1>").unwrap();
            fs::write(root.join("assets/app.js"), contents).unwrap();
        }
        let registry = PreviewRegistry::default();
        let first_url = registry
            .register(
                first.canonicalize().unwrap(),
                Path::new("index.html"),
                Some(scope("task-a")),
            )
            .unwrap();
        let second_url = registry
            .register(
                second.canonicalize().unwrap(),
                Path::new("index.html"),
                Some(scope("task-b")),
            )
            .unwrap();
        let first_parsed = tauri::Url::parse(&first_url).unwrap();
        let second_parsed = tauri::Url::parse(&second_url).unwrap();
        let first_token = super::preview_token(&first_parsed).unwrap();
        let second_token = super::preview_token(&second_parsed).unwrap();

        assert_eq!(
            registry
                .respond(&protocol_request(first_token, "/assets/app.js"))
                .body(),
            b"first"
        );
        assert_eq!(
            registry
                .respond(&protocol_request(second_token, "/assets/app.js"))
                .body(),
            b"second"
        );
        let unknown = uuid::Uuid::now_v7().to_string();
        assert_eq!(
            registry
                .respond(&protocol_request(&unknown, "/assets/app.js"))
                .status(),
            StatusCode::NOT_FOUND
        );

        registry
            .register_task_preview_target("xiao-task-preview-task", scope("task-a"), &first_parsed)
            .unwrap();
        assert!(!registry.navigation_allowed(
            "xiao-task-preview-task",
            &first_parsed,
            &second_parsed,
        ));
        assert!(registry.navigation_allowed(
            "xiao-task-preview-task",
            &first_parsed,
            &first_parsed,
        ));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn explicit_navigation_allowance_is_exact_and_one_shot() {
        let registry = PreviewRegistry::default();
        let preview = preview_url();
        let external = tauri::Url::parse("http://127.0.0.1:3000/").unwrap();
        let other_external = tauri::Url::parse("http://127.0.0.1:4000/").unwrap();

        registry
            .register_task_preview_target("xiao-task-preview-task", scope("task"), &external)
            .unwrap();
        registry.allow_navigation("xiao-task-preview-task", &external);
        assert!(!registry.navigation_allowed("xiao-task-preview-task", &preview, &other_external));
        assert!(!registry.navigation_allowed("xiao-task-preview-task", &preview, &external));

        registry.allow_navigation("xiao-task-preview-task", &external);
        assert!(registry.navigation_allowed("xiao-task-preview-task", &preview, &external));
        assert!(!registry.navigation_allowed("xiao-task-preview-task", &preview, &external));
    }

    #[test]
    fn history_allowance_is_one_shot_and_never_allows_privileged_schemes() {
        let registry = PreviewRegistry::default();
        let preview = preview_url();
        let external = tauri::Url::parse("http://localhost:3000/").unwrap();
        let local_file = tauri::Url::parse("file:///private.txt").unwrap();

        registry
            .register_task_preview_target("xiao-task-preview-task", scope("task"), &external)
            .unwrap();
        registry.allow_history_navigation("xiao-task-preview-task");
        assert!(registry.navigation_allowed("xiao-task-preview-task", &preview, &external));
        assert!(!registry.navigation_allowed("xiao-task-preview-task", &preview, &external));

        registry.allow_history_navigation("xiao-task-preview-task");
        assert!(!registry.navigation_allowed("xiao-task-preview-task", &preview, &local_file));
        assert!(!registry.navigation_allowed("xiao-task-preview-task", &preview, &external));

        registry.navigation_allowances.lock().unwrap().insert(
            "xiao-task-preview-task".to_owned(),
            NavigationAllowance::HistoryTraversal(Instant::now() - Duration::from_secs(1)),
        );
        assert!(!registry.navigation_allowed("xiao-task-preview-task", &preview, &external));
    }

    #[test]
    fn task_preview_rejects_external_redirects_and_fake_loopback_hosts() {
        let registry = PreviewRegistry::default();
        let local = tauri::Url::parse("http://127.0.0.1:3000/").unwrap();
        let external = tauri::Url::parse("https://example.com/").unwrap();
        let fake_loopback = tauri::Url::parse("http://127.example.com/").unwrap();

        assert!(!registry.navigation_allowed("xiao-task-preview-task", &local, &external));
        assert!(!registry.navigation_allowed("xiao-task-preview-task", &local, &fake_loopback));
    }

    #[test]
    fn codex_preview_targets_are_scoped_to_the_exact_project_task_and_execution_root() {
        let registry = PreviewRegistry::default();
        let task_a = PreviewScope {
            project_path: "C:/project-a".to_owned(),
            task_id: "shared".to_owned(),
            execution_root: "C:/worktree-a".to_owned(),
        };
        let task_b = PreviewScope {
            project_path: "C:/project-b".to_owned(),
            task_id: "shared".to_owned(),
            execution_root: "C:/worktree-b".to_owned(),
        };
        registry
            .register_task_preview_target(
                "xiao-task-preview-a",
                task_a.clone(),
                &Url::parse("http://127.0.0.1:4101/").unwrap(),
            )
            .unwrap();
        registry
            .register_task_preview_target(
                "xiao-task-preview-b",
                task_b.clone(),
                &Url::parse("http://127.0.0.1:4102/").unwrap(),
            )
            .unwrap();

        assert_eq!(
            registry.task_preview_targets(&task_a),
            vec![(
                "xiao-task-preview-a".to_owned(),
                vec!["http://127.0.0.1:4101".to_owned()]
            )]
        );
        assert!(registry
            .task_preview_targets(&PreviewScope {
                project_path: "C:/project-a".to_owned(),
                task_id: "shared".to_owned(),
                execution_root: "C:/other-root".to_owned(),
            })
            .is_empty());
    }

    #[test]
    fn native_webviews_reject_privileged_page_navigation() {
        let registry = PreviewRegistry::default();
        let external = tauri::Url::parse("https://example.com/").unwrap();
        let local_file = tauri::Url::parse("file:///private.txt").unwrap();
        let main = tauri::Url::parse("https://tauri.localhost/index.html").unwrap();
        let main_route = tauri::Url::parse("https://tauri.localhost/settings").unwrap();

        assert!(!registry.navigation_allowed("xiao-task-preview-task", &external, &local_file));
        assert!(!registry.navigation_allowed("xiao-game", &external, &local_file));
        assert!(registry.navigation_allowed("main", &main, &main_route));
        assert!(!registry.navigation_allowed("main", &main, &external));
        assert!(!registry.navigation_allowed("main", &main, &local_file));
        assert!(!registry.navigation_allowed("unknown", &external, &external));
    }

    #[test]
    fn main_webview_allows_only_known_initial_app_origins() {
        let registry = PreviewRegistry::default();
        let blank = tauri::Url::parse("about:blank").unwrap();
        let production = tauri::Url::parse("tauri://localhost/index.html").unwrap();
        let windows = tauri::Url::parse("http://tauri.localhost/index.html").unwrap();
        let development = tauri::Url::parse("http://127.0.0.1:1420/index.html").unwrap();
        let wrong_development_port = tauri::Url::parse("http://127.0.0.1:1421/index.html").unwrap();
        let external = tauri::Url::parse("https://example.com/").unwrap();

        assert!(registry.navigation_allowed("main", &blank, &production));
        assert!(registry.navigation_allowed("main", &blank, &windows));
        assert_eq!(
            registry.navigation_allowed("main", &blank, &development),
            cfg!(debug_assertions)
        );
        assert!(!registry.navigation_allowed("main", &blank, &wrong_development_port));
        assert!(!registry.navigation_allowed("main", &blank, &external));
    }

    fn protocol_request(token: &str, path: &str) -> Request<Vec<u8>> {
        Request::builder()
            .uri(format!("xiao-preview://{token}{path}"))
            .body(Vec::new())
            .unwrap()
    }

    fn preview_url() -> tauri::Url {
        tauri::Url::parse(&format!(
            "http://xiao-preview.{}/index.html",
            uuid::Uuid::now_v7()
        ))
        .unwrap()
    }
}
