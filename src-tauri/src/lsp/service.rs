use std::collections::HashMap;
use std::ffi::OsString;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

#[cfg(test)]
use super::protocol::relative_path_from_uri;
use super::protocol::{
    io_error, normalize_location, normalize_locations, path_to_file_uri, read_message,
    write_message,
};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const DIAGNOSTIC_WAIT: Duration = Duration::from_secs(2);
const COLD_SEMANTIC_ATTEMPTS: usize = 100;
const MAX_DOCUMENT_BYTES: u64 = 2 * 1024 * 1024;
const DEFAULT_RESULT_LIMIT: usize = 100;
const MAX_RESULT_LIMIT: usize = 200;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
enum Language {
    TypeScript,
    Rust,
}

impl Language {
    fn from_name(value: &str) -> Result<Self, String> {
        match value {
            "typescript" => Ok(Self::TypeScript),
            "rust" => Ok(Self::Rust),
            _ => Err("LSP language must be `typescript` or `rust`.".to_owned()),
        }
    }

    fn for_path(path: &Path) -> Result<Self, String> {
        let extension = path
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        match extension.as_str() {
            "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" | "mts" | "cts" => Ok(Self::TypeScript),
            "rs" => Ok(Self::Rust),
            _ => Err(
                "Xiao LSP currently supports TypeScript, JavaScript, and Rust files.".to_owned(),
            ),
        }
    }

    fn document_id(self, path: &Path) -> &'static str {
        if self == Self::Rust {
            return "rust";
        }
        match path
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str()
        {
            "tsx" => "typescriptreact",
            "js" | "mjs" | "cjs" => "javascript",
            "jsx" => "javascriptreact",
            _ => "typescript",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::TypeScript => "TypeScript",
            Self::Rust => "Rust",
        }
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct ServerKey {
    environment_id: String,
    execution_root: PathBuf,
    language: Language,
}

#[derive(Default)]
pub(crate) struct LspManager {
    servers: Mutex<HashMap<ServerKey, Arc<LspServer>>>,
}

impl LspManager {
    pub(crate) fn execute_tool(
        &self,
        environment_id: &str,
        execution_root: &str,
        tool: &str,
        arguments: Value,
    ) -> Result<Value, String> {
        validate_environment_id(environment_id)?;
        let root = canonical_root(execution_root)?;
        match tool {
            "definition" => self.position_tool(
                environment_id,
                &root,
                &arguments,
                "textDocument/definition",
                false,
            ),
            "references" => self.position_tool(
                environment_id,
                &root,
                &arguments,
                "textDocument/references",
                true,
            ),
            "workspace_symbols" => self.workspace_symbols(environment_id, &root, &arguments),
            "diagnostics" => self.diagnostics(environment_id, &root, &arguments),
            _ => Err(format!("Unknown Xiao LSP tool `{tool}`.")),
        }
    }

    pub(crate) fn stop_environment(&self, environment_id: &str) -> Result<(), String> {
        validate_environment_id(environment_id)?;
        let stopped = {
            let mut servers = self.servers.lock().map_err(|error| error.to_string())?;
            let keys = servers
                .keys()
                .filter(|key| key.environment_id == environment_id)
                .cloned()
                .collect::<Vec<_>>();
            keys.into_iter()
                .filter_map(|key| servers.remove(&key))
                .collect::<Vec<_>>()
        };
        drop(stopped);
        Ok(())
    }

    fn position_tool(
        &self,
        environment_id: &str,
        root: &Path,
        arguments: &Value,
        method: &str,
        references: bool,
    ) -> Result<Value, String> {
        let relative_path = required_string(arguments, "path")?;
        let line = required_positive_integer(arguments, "line")? - 1;
        let character = required_positive_integer(arguments, "character")? - 1;
        let limit = result_limit(arguments)?;
        let path = resolve_document(root, relative_path)?;
        let language = Language::for_path(&path)?;
        let server = self.server(environment_id, root, language)?;
        let uri = server.synchronize_document(&path, language.document_id(&path))?;
        let mut params = json!({
            "textDocument": { "uri": uri },
            "position": { "line": line, "character": character },
        });
        if references {
            params["context"] = json!({
                "includeDeclaration": arguments
                    .get("includeDeclaration")
                    .and_then(Value::as_bool)
                    .unwrap_or(true)
            });
        }
        let result = server.request_semantic(method, params)?;
        normalize_locations(root, &result, limit)
    }

    fn workspace_symbols(
        &self,
        environment_id: &str,
        root: &Path,
        arguments: &Value,
    ) -> Result<Value, String> {
        let language = Language::from_name(required_string(arguments, "language")?)?;
        let query = required_string(arguments, "query")?;
        let limit = result_limit(arguments)?;
        let server = self.server(environment_id, root, language)?;
        let result = server.request_semantic("workspace/symbol", json!({ "query": query }))?;
        normalize_workspace_symbols(root, &result, limit)
    }

    fn diagnostics(
        &self,
        environment_id: &str,
        root: &Path,
        arguments: &Value,
    ) -> Result<Value, String> {
        let relative_path = required_string(arguments, "path")?;
        let limit = result_limit(arguments)?;
        let path = resolve_document(root, relative_path)?;
        let language = Language::for_path(&path)?;
        let server = self.server(environment_id, root, language)?;
        let uri = server.synchronize_document(&path, language.document_id(&path))?;
        let mut diagnostics = server.wait_for_diagnostics(&uri, DIAGNOSTIC_WAIT)?;
        if diagnostics.is_none() {
            diagnostics = server
                .request(
                    "textDocument/diagnostic",
                    json!({ "textDocument": { "uri": uri } }),
                )
                .ok()
                .and_then(|value| value.get("items").and_then(Value::as_array).cloned());
        }
        normalize_diagnostics(
            relative_path,
            diagnostics.as_deref().unwrap_or_default(),
            limit,
        )
    }

    fn server(
        &self,
        environment_id: &str,
        root: &Path,
        language: Language,
    ) -> Result<Arc<LspServer>, String> {
        let key = ServerKey {
            environment_id: environment_id.to_owned(),
            execution_root: root.to_path_buf(),
            language,
        };
        let mut servers = self.servers.lock().map_err(|error| error.to_string())?;
        if let Some(server) = servers.get(&key) {
            if server.is_alive()? {
                return Ok(Arc::clone(server));
            }
            servers.remove(&key);
        }
        let command = language_server_command(root, language)?;
        let server = Arc::new(LspServer::spawn(root, language, command, true)?);
        servers.insert(key, Arc::clone(&server));
        Ok(server)
    }
}

#[derive(Clone)]
struct OpenDocument {
    digest: [u8; 32],
    version: i64,
}

#[derive(Default)]
struct DiagnosticsState {
    values: Mutex<HashMap<String, Vec<Value>>>,
    updated: Condvar,
}

type PendingRequest = mpsc::Sender<Result<Value, String>>;

struct LspServer {
    child: Mutex<Option<Child>>,
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    pending: Arc<Mutex<HashMap<u64, PendingRequest>>>,
    diagnostics: Arc<DiagnosticsState>,
    stderr_log: Arc<Mutex<String>>,
    open_documents: Mutex<HashMap<String, OpenDocument>>,
    next_id: AtomicU64,
    semantic_ready: std::sync::atomic::AtomicBool,
}

impl LspServer {
    fn spawn(
        root: &Path,
        language: Language,
        command: Command,
        supervised: bool,
    ) -> Result<Self, String> {
        let mut command = if supervised {
            crate::process::supervise_command(command)?
        } else {
            command
        };
        command
            .current_dir(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn().map_err(|error| {
            format!(
                "Could not start the {} language server: {error}",
                language.label()
            )
        })?;
        let stdin = child
            .stdin
            .take()
            .ok_or("The language server stdin is unavailable.")?;
        let stdout = child
            .stdout
            .take()
            .ok_or("The language server stdout is unavailable.")?;
        let stderr = child
            .stderr
            .take()
            .ok_or("The language server stderr is unavailable.")?;
        let stdin = Arc::new(Mutex::new(Some(stdin)));
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let diagnostics = Arc::new(DiagnosticsState::default());
        let stderr_log = Arc::new(Mutex::new(String::new()));
        let root_uri = path_to_file_uri(root)?;
        if let Err(error) = start_stdout_reader(
            stdout,
            Arc::clone(&stdin),
            Arc::clone(&pending),
            Arc::clone(&diagnostics),
            root_uri.clone(),
        ) {
            crate::process::terminate_process_tree(&mut child);
            return Err(error);
        }
        let stderr_capture = Arc::clone(&stderr_log);
        if let Err(error) = thread::Builder::new()
            .name(format!(
                "xiao-lsp-{}-stderr",
                language.label().to_ascii_lowercase()
            ))
            .spawn(move || {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    if let Ok(mut log) = stderr_capture.lock() {
                        log.push_str(&line);
                        log.push('\n');
                        if log.len() > 8 * 1024 {
                            let mut start = log.len() - 8 * 1024;
                            while !log.is_char_boundary(start) {
                                start += 1;
                            }
                            *log = log[start..].to_owned();
                        }
                    }
                }
            })
        {
            if let Ok(mut stdin) = stdin.lock() {
                *stdin = None;
            }
            crate::process::terminate_process_tree(&mut child);
            return Err(format!("Could not monitor language server stderr: {error}"));
        }
        let server = Self {
            child: Mutex::new(Some(child)),
            stdin,
            pending,
            diagnostics,
            stderr_log,
            open_documents: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            semantic_ready: std::sync::atomic::AtomicBool::new(false),
        };
        server.request(
            "initialize",
            json!({
                "processId": std::process::id(),
                "clientInfo": {
                    "name": "xiao-workbench",
                    "version": env!("CARGO_PKG_VERSION")
                },
                "rootUri": root_uri,
                "capabilities": {
                    "general": { "positionEncodings": ["utf-16"] },
                    "workspace": {
                        "workspaceFolders": true,
                        "symbol": { "dynamicRegistration": false }
                    },
                    "textDocument": {
                        "definition": { "dynamicRegistration": false, "linkSupport": true },
                        "references": { "dynamicRegistration": false },
                        "publishDiagnostics": { "relatedInformation": true }
                    }
                },
                "workspaceFolders": [{ "uri": root_uri, "name": workspace_name(root) }]
            }),
        )?;
        server.notify("initialized", json!({}))?;
        Ok(server)
    }

    fn is_alive(&self) -> Result<bool, String> {
        let mut child = self.child.lock().map_err(|error| error.to_string())?;
        let Some(child) = child.as_mut() else {
            return Ok(false);
        };
        child
            .try_wait()
            .map(|status| status.is_none())
            .map_err(|error| format!("Could not inspect the language server: {error}"))
    }

    fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = mpsc::channel();
        self.pending
            .lock()
            .map_err(|error| error.to_string())?
            .insert(id, sender);
        if let Err(error) = self.send(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        })) {
            self.pending
                .lock()
                .map_err(|lock_error| lock_error.to_string())?
                .remove(&id);
            return Err(self.with_stderr(error));
        }
        match receiver.recv_timeout(REQUEST_TIMEOUT) {
            Ok(result) => result.map_err(|error| self.with_stderr(error)),
            Err(_) => {
                self.pending
                    .lock()
                    .map_err(|error| error.to_string())?
                    .remove(&id);
                Err(self.with_stderr(format!(
                    "The language server timed out handling `{method}`."
                )))
            }
        }
    }

    fn request_semantic(&self, method: &str, params: Value) -> Result<Value, String> {
        let cold_start = !self.semantic_ready.load(Ordering::Acquire);
        let attempts = if cold_start {
            COLD_SEMANTIC_ATTEMPTS
        } else {
            3
        };
        let mut last_result = Value::Null;
        for attempt in 0..attempts {
            match self.request(method, params.clone()) {
                Ok(result) => {
                    let has_result = result
                        .as_array()
                        .map(|values| !values.is_empty())
                        .unwrap_or(!result.is_null());
                    last_result = result;
                    if has_result || !cold_start {
                        self.semantic_ready.store(true, Ordering::Release);
                        return Ok(last_result);
                    }
                }
                Err(error) if transient_semantic_error(&error) => {}
                Err(error) => return Err(error),
            }
            if attempt + 1 < attempts {
                thread::sleep(Duration::from_millis(250));
            }
        }
        self.semantic_ready.store(true, Ordering::Release);
        Ok(last_result)
    }

    fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        self.send(&json!({ "jsonrpc": "2.0", "method": method, "params": params }))
    }

    fn send(&self, message: &Value) -> Result<(), String> {
        let mut stdin = self.stdin.lock().map_err(|error| error.to_string())?;
        let stdin = stdin
            .as_mut()
            .ok_or("The language server is not connected.")?;
        write_message(stdin, message)
    }

    fn synchronize_document(&self, path: &Path, language_id: &str) -> Result<String, String> {
        let metadata =
            fs::metadata(path).map_err(|error| io_error(error, "inspect the LSP file"))?;
        if metadata.len() > MAX_DOCUMENT_BYTES {
            return Err("LSP files are limited to 2 MB.".to_owned());
        }
        let text =
            fs::read_to_string(path).map_err(|error| io_error(error, "read the LSP file"))?;
        let uri = path_to_file_uri(path)?;
        let digest: [u8; 32] = Sha256::digest(text.as_bytes()).into();
        let update = {
            let mut documents = self
                .open_documents
                .lock()
                .map_err(|error| error.to_string())?;
            match documents.get_mut(&uri) {
                Some(document) if document.digest == digest => None,
                Some(document) => {
                    document.version += 1;
                    document.digest = digest;
                    Some((false, document.version))
                }
                None => {
                    documents.insert(uri.clone(), OpenDocument { digest, version: 1 });
                    Some((true, 1))
                }
            }
        };
        if update.is_some() {
            self.diagnostics
                .values
                .lock()
                .map_err(|error| error.to_string())?
                .remove(&uri);
        }
        match update {
            Some((true, version)) => self.notify(
                "textDocument/didOpen",
                json!({
                    "textDocument": {
                        "uri": uri,
                        "languageId": language_id,
                        "version": version,
                        "text": text,
                    }
                }),
            )?,
            Some((false, version)) => self.notify(
                "textDocument/didChange",
                json!({
                    "textDocument": { "uri": uri, "version": version },
                    "contentChanges": [{ "text": text }]
                }),
            )?,
            None => {}
        }
        Ok(uri)
    }

    fn wait_for_diagnostics(
        &self,
        uri: &str,
        timeout: Duration,
    ) -> Result<Option<Vec<Value>>, String> {
        let values = self
            .diagnostics
            .values
            .lock()
            .map_err(|error| error.to_string())?;
        let (values, _) = self
            .diagnostics
            .updated
            .wait_timeout_while(values, timeout, |values| !values.contains_key(uri))
            .map_err(|error| error.to_string())?;
        Ok(values.get(uri).cloned())
    }

    fn stderr(&self) -> String {
        self.stderr_log
            .lock()
            .map(|log| log.clone())
            .unwrap_or_default()
    }

    fn with_stderr(&self, error: String) -> String {
        let stderr = self.stderr();
        let stderr = stderr.trim();
        if stderr.is_empty() {
            error
        } else {
            format!(
                "{error} Language server stderr: {}",
                truncate_utf8(stderr, 2_000)
            )
        }
    }
}

impl Drop for LspServer {
    fn drop(&mut self) {
        if let Ok(mut stdin) = self.stdin.lock() {
            *stdin = None;
        }
        if let Ok(mut child) = self.child.lock() {
            if let Some(child) = child.as_mut() {
                crate::process::terminate_process_tree(child);
            }
            *child = None;
        }
        fail_pending(&self.pending, "The language server stopped.");
    }
}

fn start_stdout_reader(
    stdout: impl std::io::Read + Send + 'static,
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    pending: Arc<Mutex<HashMap<u64, PendingRequest>>>,
    diagnostics: Arc<DiagnosticsState>,
    root_uri: String,
) -> Result<(), String> {
    thread::Builder::new()
        .name("xiao-lsp-stdout".to_owned())
        .spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let message = match read_message(&mut reader) {
                    Ok(message) => message,
                    Err(error) => {
                        fail_pending(&pending, &error);
                        break;
                    }
                };
                if message.get("method").is_none() {
                    if let Some(id) = message.get("id").and_then(Value::as_u64) {
                        resolve_response(&pending, id, &message);
                    }
                    continue;
                }
                if let Some(id) = message.get("id").cloned() {
                    let result = server_request_result(
                        message
                            .get("method")
                            .and_then(Value::as_str)
                            .unwrap_or_default(),
                        message.get("params").unwrap_or(&Value::Null),
                        &root_uri,
                    );
                    if let Ok(mut stdin) = stdin.lock() {
                        if let Some(stdin) = stdin.as_mut() {
                            let _ = write_message(
                                stdin,
                                &json!({ "jsonrpc": "2.0", "id": id, "result": result }),
                            );
                        }
                    }
                    continue;
                }
                if message.get("method").and_then(Value::as_str)
                    == Some("textDocument/publishDiagnostics")
                {
                    if let (Some(uri), Some(items)) = (
                        message
                            .get("params")
                            .and_then(|params| params.get("uri"))
                            .and_then(Value::as_str),
                        message
                            .get("params")
                            .and_then(|params| params.get("diagnostics"))
                            .and_then(Value::as_array),
                    ) {
                        if let Ok(mut values) = diagnostics.values.lock() {
                            values.insert(uri.to_owned(), items.clone());
                            diagnostics.updated.notify_all();
                        }
                    }
                }
            }
        })
        .map(|_| ())
        .map_err(|error| format!("Could not monitor language server stdout: {error}"))
}

fn resolve_response(pending: &Mutex<HashMap<u64, PendingRequest>>, id: u64, message: &Value) {
    let sender = pending
        .lock()
        .ok()
        .and_then(|mut pending| pending.remove(&id));
    let Some(sender) = sender else {
        return;
    };
    let result = if let Some(error) = message.get("error") {
        Err(error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("The language server rejected the request.")
            .to_owned())
    } else {
        Ok(message.get("result").cloned().unwrap_or(Value::Null))
    };
    let _ = sender.send(result);
}

fn fail_pending(pending: &Mutex<HashMap<u64, PendingRequest>>, message: &str) {
    let requests = pending
        .lock()
        .map(|mut pending| {
            pending
                .drain()
                .map(|(_, sender)| sender)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    for request in requests {
        let _ = request.send(Err(message.to_owned()));
    }
}

fn server_request_result(method: &str, params: &Value, root_uri: &str) -> Value {
    match method {
        "workspace/configuration" => json!(vec![
            Value::Null;
            params
                .get("items")
                .and_then(Value::as_array)
                .map(Vec::len)
                .unwrap_or(0)
        ]),
        "workspace/workspaceFolders" => {
            json!([{ "uri": root_uri, "name": "workspace" }])
        }
        "workspace/applyEdit" => json!({
            "applied": false,
            "failureReason": "Xiao's LSP integration is read-only."
        }),
        _ => Value::Null,
    }
}

fn language_server_command(root: &Path, language: Language) -> Result<Command, String> {
    match language {
        Language::Rust => {
            let executable = find_executable(root, "rust-analyzer").ok_or(
                "rust-analyzer was not found. Install it and restart Xiao before using Rust LSP tools.",
            )?;
            Ok(command_for_executable(&executable, &[]))
        }
        Language::TypeScript => {
            let executable = find_executable(root, "typescript-language-server").ok_or(
                "typescript-language-server was not found on a trusted PATH location. Install it globally and restart Xiao before using TypeScript LSP tools.",
            )?;
            Ok(command_for_executable(&executable, &["--stdio"]))
        }
    }
}

fn command_for_executable(executable: &Path, arguments: &[&str]) -> Command {
    #[cfg(windows)]
    if executable
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat")
        })
    {
        let mut command = Command::new("cmd.exe");
        let mut script = format!("\"{}\"", executable.display());
        for argument in arguments {
            script.push(' ');
            script.push_str(argument);
        }
        command.args(["/D", "/S", "/C"]).arg(script);
        return command;
    }
    let mut command = Command::new(executable);
    command.args(arguments);
    command
}

fn find_executable(root: &Path, name: &str) -> Option<PathBuf> {
    let directories = std::env::var_os("PATH")
        .into_iter()
        .flat_map(|paths| std::env::split_paths(&paths).collect::<Vec<_>>());
    find_executable_in(root, name, directories)
}

fn find_executable_in(
    root: &Path,
    name: &str,
    directories: impl IntoIterator<Item = PathBuf>,
) -> Option<PathBuf> {
    let root = root.canonicalize().ok()?;
    let candidates = executable_names(name);
    for directory in directories {
        if !directory.is_absolute() {
            continue;
        }
        for candidate in &candidates {
            let path = directory.join(candidate);
            if !path.is_file() {
                continue;
            }
            let Ok(resolved) = path.canonicalize() else {
                continue;
            };
            if !path_is_within(&resolved, &root) {
                return Some(path);
            }
        }
    }
    None
}

fn path_is_within(path: &Path, parent: &Path) -> bool {
    #[cfg(windows)]
    {
        let path = path.to_string_lossy().replace('\\', "/").to_lowercase();
        let parent = parent
            .to_string_lossy()
            .replace('\\', "/")
            .trim_end_matches('/')
            .to_lowercase();
        path == parent
            || path
                .strip_prefix(&parent)
                .is_some_and(|remainder| remainder.starts_with('/'))
    }
    #[cfg(not(windows))]
    {
        path.starts_with(parent)
    }
}

fn executable_names(name: &str) -> Vec<OsString> {
    #[cfg(windows)]
    {
        [".exe", ".cmd", ".bat", ""]
            .into_iter()
            .map(|suffix| OsString::from(format!("{name}{suffix}")))
            .collect()
    }
    #[cfg(not(windows))]
    {
        vec![OsString::from(name)]
    }
}

fn normalize_workspace_symbols(root: &Path, result: &Value, limit: usize) -> Result<Value, String> {
    let symbols = result.as_array().cloned().unwrap_or_default();
    let normalized = symbols
        .iter()
        .filter_map(|symbol| {
            let location = symbol.get("location")?;
            let normalized_location = normalize_location(root, location).ok()?;
            Some(json!({
                "name": symbol.get("name").and_then(Value::as_str).unwrap_or(""),
                "kind": symbol.get("kind").and_then(Value::as_u64),
                "containerName": symbol.get("containerName").and_then(Value::as_str),
                "location": normalized_location,
            }))
        })
        .take(limit)
        .collect::<Vec<_>>();
    Ok(Value::Array(normalized))
}

fn normalize_diagnostics(path: &str, diagnostics: &[Value], limit: usize) -> Result<Value, String> {
    diagnostics
        .iter()
        .take(limit)
        .map(|diagnostic| {
            let range = diagnostic
                .get("range")
                .ok_or("The language server returned a diagnostic without a range.")?;
            let start = range
                .get("start")
                .ok_or("The language server returned a diagnostic without a start.")?;
            let end = range.get("end").unwrap_or(start);
            Ok(json!({
                "path": path.replace('\\', "/"),
                "line": lsp_coordinate(start, "line")? + 1,
                "character": lsp_coordinate(start, "character")? + 1,
                "endLine": lsp_coordinate(end, "line")? + 1,
                "endCharacter": lsp_coordinate(end, "character")? + 1,
                "severity": diagnostic.get("severity").and_then(Value::as_u64),
                "code": diagnostic.get("code"),
                "source": diagnostic.get("source").and_then(Value::as_str),
                "message": diagnostic
                    .get("message")
                    .and_then(Value::as_str)
                    .map(|message| truncate_utf8(message, 2_000))
                    .unwrap_or_default(),
            }))
        })
        .collect::<Result<Vec<_>, String>>()
        .map(Value::Array)
}

fn lsp_coordinate(value: &Value, key: &str) -> Result<u64, String> {
    value
        .get(key)
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("The language server returned a range without `{key}`."))
}

fn canonical_root(execution_root: &str) -> Result<PathBuf, String> {
    if execution_root.trim().is_empty() {
        return Err("An execution root is required for LSP tools.".to_owned());
    }
    let root = PathBuf::from(execution_root)
        .canonicalize()
        .map_err(|error| format!("Could not resolve the LSP execution root: {error}"))?;
    if !root.is_dir() {
        return Err("The LSP execution root is not a directory.".to_owned());
    }
    Ok(root)
}

fn resolve_document(root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let relative = Path::new(relative_path);
    if relative_path.trim().is_empty()
        || relative.is_absolute()
        || relative.components().any(|component| {
            matches!(
                component,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )
        })
    {
        return Err("LSP paths must be relative to the execution root.".to_owned());
    }
    let path = root
        .join(relative)
        .canonicalize()
        .map_err(|error| format!("Could not resolve the LSP file: {error}"))?;
    if !path.starts_with(root) || !path.is_file() {
        return Err("The LSP file must stay inside the execution root.".to_owned());
    }
    Ok(path)
}

fn validate_environment_id(environment_id: &str) -> Result<(), String> {
    if environment_id.is_empty()
        || environment_id.len() > 128
        || !environment_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("The LSP execution environment id is invalid.".to_owned());
    }
    Ok(())
}

fn required_string<'a>(arguments: &'a Value, name: &str) -> Result<&'a str, String> {
    arguments
        .as_object()
        .ok_or("LSP tool arguments must be an object.")?
        .get(name)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("LSP tool argument `{name}` is required."))
}

fn required_positive_integer(arguments: &Value, name: &str) -> Result<u64, String> {
    arguments
        .get(name)
        .and_then(Value::as_u64)
        .filter(|value| *value > 0)
        .ok_or_else(|| format!("LSP tool argument `{name}` must be a positive integer."))
}

fn result_limit(arguments: &Value) -> Result<usize, String> {
    let limit = arguments
        .get("limit")
        .map(|value| {
            value
                .as_u64()
                .filter(|limit| *limit > 0 && *limit <= MAX_RESULT_LIMIT as u64)
                .ok_or("LSP result limit must be between 1 and 200.")
        })
        .transpose()?
        .unwrap_or(DEFAULT_RESULT_LIMIT as u64);
    Ok(limit as usize)
}

fn workspace_name(root: &Path) -> String {
    root.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("workspace")
        .to_owned()
}

fn truncate_utf8(value: &str, limit: usize) -> String {
    if value.len() <= limit {
        return value.to_owned();
    }
    let mut end = limit;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &value[..end])
}

fn transient_semantic_error(error: &str) -> bool {
    let error = error.to_ascii_lowercase();
    error.contains("content modified") || error.contains("request cancelled")
}

#[cfg(test)]
mod tests {
    use super::*;

    const FAKE_SERVER_ENV: &str = "XIAO_LSP_FAKE_SERVER";

    #[test]
    fn language_detection_is_deliberately_narrow() {
        assert_eq!(
            Language::for_path(Path::new("src/app.tsx")),
            Ok(Language::TypeScript)
        );
        assert_eq!(
            Language::for_path(Path::new("src/lib.rs")),
            Ok(Language::Rust)
        );
        assert!(Language::for_path(Path::new("README.md")).is_err());
    }

    #[test]
    fn executable_discovery_skips_workspace_controlled_paths() {
        let base = std::env::temp_dir().join(format!(
            "xiao-lsp-executable-trust-{}",
            uuid::Uuid::now_v7()
        ));
        let root = base.join("workspace");
        let workspace_bin = root.join("node_modules").join(".bin");
        let external_bin = base.join("global-bin");
        fs::create_dir_all(&workspace_bin).unwrap();
        fs::create_dir_all(&external_bin).unwrap();
        let executable_name = executable_names("typescript-language-server")
            .into_iter()
            .next()
            .unwrap();
        let workspace_executable = workspace_bin.join(&executable_name);
        let external_executable = external_bin.join(&executable_name);
        fs::write(&workspace_executable, []).unwrap();
        fs::write(&external_executable, []).unwrap();

        assert_eq!(
            find_executable_in(
                &root,
                "typescript-language-server",
                [workspace_bin.clone(), external_bin]
            ),
            Some(external_executable)
        );
        assert_eq!(
            find_executable_in(&root, "typescript-language-server", [workspace_bin]),
            None
        );

        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn result_limits_are_bounded() {
        assert_eq!(result_limit(&json!({})), Ok(DEFAULT_RESULT_LIMIT));
        assert_eq!(result_limit(&json!({ "limit": 1 })), Ok(1));
        assert!(result_limit(&json!({ "limit": 0 })).is_err());
        assert!(result_limit(&json!({ "limit": 201 })).is_err());
    }

    #[test]
    fn read_only_server_requests_reject_workspace_edits() {
        let result = server_request_result("workspace/applyEdit", &Value::Null, "file:///root");
        assert_eq!(result["applied"], false);
        assert!(result["failureReason"]
            .as_str()
            .unwrap()
            .contains("read-only"));
    }

    #[test]
    fn diagnostics_are_normalized_to_one_based_positions() {
        let result = normalize_diagnostics(
            "src/main.rs",
            &[json!({
                "range": {
                    "start": { "line": 2, "character": 4 },
                    "end": { "line": 2, "character": 7 }
                },
                "severity": 1,
                "source": "rust-analyzer",
                "message": "broken"
            })],
            10,
        )
        .unwrap();
        assert_eq!(result[0]["path"], "src/main.rs");
        assert_eq!(result[0]["line"], 3);
        assert_eq!(result[0]["character"], 5);
    }

    #[test]
    fn traversal_never_reaches_a_document() {
        let root = std::env::temp_dir().join(format!("xiao-lsp-root-{}", uuid::Uuid::now_v7()));
        fs::create_dir_all(&root).unwrap();
        assert!(resolve_document(&root.canonicalize().unwrap(), "../outside.rs").is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn workspace_symbol_locations_outside_the_root_are_dropped() {
        let root = std::env::temp_dir().join(format!("xiao-lsp-root-{}", uuid::Uuid::now_v7()));
        fs::create_dir_all(&root).unwrap();
        let result = normalize_workspace_symbols(
            &root.canonicalize().unwrap(),
            &json!([{
                "name": "outside",
                "kind": 12,
                "location": {
                    "uri": "file:///definitely/outside.rs",
                    "range": {
                        "start": { "line": 0, "character": 0 },
                        "end": { "line": 0, "character": 1 }
                    }
                }
            }]),
            10,
        )
        .unwrap();
        assert_eq!(result, json!([]));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn relative_uri_results_stay_inside_the_execution_root() {
        let root = std::env::temp_dir().join(format!("xiao-lsp-uri-{}", uuid::Uuid::now_v7()));
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/lib.rs"), "fn example() {}\n").unwrap();
        let canonical_root = root.canonicalize().unwrap();
        let uri = path_to_file_uri(&root.join("src/lib.rs")).unwrap();
        assert_eq!(
            relative_path_from_uri(&canonical_root, &uri).unwrap(),
            "src/lib.rs"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn stdio_transport_executes_read_only_requests_against_a_fake_server() {
        let root = std::env::temp_dir().join(format!("xiao-lsp-fake-{}", uuid::Uuid::now_v7()));
        fs::create_dir_all(root.join("src")).unwrap();
        let file = root.join("src/lib.rs");
        fs::write(&file, "fn example() {}\n").unwrap();
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "lsp::service::tests::fake_lsp_server",
                "--ignored",
                "--nocapture",
            ])
            .env(FAKE_SERVER_ENV, "1");
        let server = LspServer::spawn(
            &root.canonicalize().unwrap(),
            Language::Rust,
            command,
            false,
        )
        .unwrap();
        let uri = server.synchronize_document(&file, "rust").unwrap();
        let definition = server
            .request(
                "textDocument/definition",
                json!({
                    "textDocument": { "uri": uri },
                    "position": { "line": 0, "character": 3 }
                }),
            )
            .unwrap();
        let normalized =
            normalize_locations(&root.canonicalize().unwrap(), &definition, 10).unwrap();
        assert_eq!(normalized[0]["path"], "src/lib.rs");
        assert_eq!(normalized[0]["line"], 1);
        let symbols = server
            .request("workspace/symbol", json!({ "query": "example" }))
            .unwrap();
        assert_eq!(symbols[0]["name"], "example");
        let diagnostics = server
            .wait_for_diagnostics(&uri, Duration::from_secs(1))
            .unwrap()
            .unwrap();
        assert_eq!(diagnostics[0]["message"], "fake diagnostic");
        fs::write(&file, "fn example() { let changed = true; }\n").unwrap();
        server.synchronize_document(&file, "rust").unwrap();
        let diagnostics = server
            .wait_for_diagnostics(&uri, Duration::from_secs(1))
            .unwrap()
            .unwrap();
        assert_eq!(diagnostics[0]["message"], "updated fake diagnostic");
        drop(server);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[ignore]
    fn fake_lsp_server() {
        if std::env::var_os(FAKE_SERVER_ENV).is_none() {
            return;
        }
        let stdin = std::io::stdin();
        let stdout = std::io::stdout();
        let mut reader = BufReader::new(stdin.lock());
        let mut writer = stdout.lock();
        let mut document_uri = None;
        while let Ok(message) = read_message(&mut reader) {
            let method = message
                .get("method")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let id = message.get("id").cloned();
            match method {
                "initialize" => {
                    write_message(
                        &mut writer,
                        &json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "result": { "capabilities": {} }
                        }),
                    )
                    .unwrap();
                }
                "textDocument/didOpen" | "textDocument/didChange" => {
                    document_uri = message["params"]["textDocument"]["uri"]
                        .as_str()
                        .map(str::to_owned);
                    let diagnostic = if method == "textDocument/didOpen" {
                        "fake diagnostic"
                    } else {
                        "updated fake diagnostic"
                    };
                    write_message(
                        &mut writer,
                        &json!({
                            "jsonrpc": "2.0",
                            "method": "textDocument/publishDiagnostics",
                            "params": {
                                "uri": document_uri,
                                "diagnostics": [{
                                    "range": {
                                        "start": { "line": 0, "character": 0 },
                                        "end": { "line": 0, "character": 2 }
                                    },
                                    "message": diagnostic
                                }]
                            }
                        }),
                    )
                    .unwrap();
                }
                "textDocument/definition" | "textDocument/references" => {
                    write_message(
                        &mut writer,
                        &json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "result": [{
                                "uri": document_uri,
                                "range": {
                                    "start": { "line": 0, "character": 3 },
                                    "end": { "line": 0, "character": 10 }
                                }
                            }]
                        }),
                    )
                    .unwrap();
                }
                "workspace/symbol" => {
                    write_message(
                        &mut writer,
                        &json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "result": [{
                                "name": "example",
                                "kind": 12,
                                "location": {
                                    "uri": document_uri,
                                    "range": {
                                        "start": { "line": 0, "character": 3 },
                                        "end": { "line": 0, "character": 10 }
                                    }
                                }
                            }]
                        }),
                    )
                    .unwrap();
                }
                _ if id.is_some() => {
                    write_message(
                        &mut writer,
                        &json!({ "jsonrpc": "2.0", "id": id, "result": null }),
                    )
                    .unwrap();
                }
                _ => {}
            }
        }
    }

    #[test]
    #[ignore]
    fn installed_rust_analyzer_resolves_a_xiao_definition() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .canonicalize()
            .unwrap();
        let path = root.join("src/lsp/mod.rs");
        let source = fs::read_to_string(&path).unwrap();
        let (line, character) = source
            .lines()
            .enumerate()
            .find_map(|(line, text)| {
                let marker = "position_schema(false)";
                text.find(marker).map(|character| (line, character))
            })
            .expect("the LSP smoke marker moved");
        let command = language_server_command(&root, Language::Rust).unwrap();
        let server = LspServer::spawn(&root, Language::Rust, command, false).unwrap();
        let uri = server.synchronize_document(&path, "rust").unwrap();
        let result = server
            .request_semantic(
                "textDocument/definition",
                json!({
                    "textDocument": { "uri": uri },
                    "position": { "line": line, "character": character }
                }),
            )
            .unwrap();
        let locations = normalize_locations(&root, &result, 10).unwrap();
        assert_eq!(locations[0]["path"], "src/lsp/mod.rs");
    }
}
