use std::{
    collections::HashMap,
    fs::File,
    io::{BufRead, BufReader, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

use serde_json::Value;
use tauri::{AppHandle, State};

use crate::execution::service::resolve_execution_context;
use crate::lsp::LspManager;
use crate::xiao::repository::XiaoRepository;

use super::runtime::{EnvironmentRuntimeRegistry, StartResult};
use super::{models, service};

const MAX_ROLLOUT_BYTES: u64 = 128 * 1024 * 1024;
const MAX_COMMAND_OUTPUT_CHARS: usize = 24_000;

#[derive(Debug, Clone)]
struct PendingRolloutCommand {
    command: models::CodexRolloutCommand,
    started_at_ms: Option<i64>,
}

#[derive(Debug, Default)]
struct RolloutCommandCache {
    offset: u64,
    pending: HashMap<String, PendingRolloutCommand>,
    completed: Vec<models::CodexRolloutCommand>,
}

static ROLLOUT_COMMAND_CACHE: OnceLock<Mutex<HashMap<PathBuf, RolloutCommandCache>>> =
    OnceLock::new();

fn default_codex_sessions_root() -> Result<PathBuf, String> {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .ok_or("Could not resolve the local user profile.")?;
    Ok(PathBuf::from(home).join(".codex").join("sessions"))
}

fn validated_rollout_path(path: &str) -> Result<PathBuf, String> {
    let candidate = Path::new(path)
        .canonicalize()
        .map_err(|error| format!("Could not open this Codex rollout: {error}"))?;
    let sessions = default_codex_sessions_root()?
        .canonicalize()
        .map_err(|error| format!("Could not resolve the local Codex sessions folder: {error}"))?;
    if !candidate.starts_with(&sessions) {
        return Err("Codex rollout is outside the local sessions folder.".to_owned());
    }
    let name = candidate
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if !name.starts_with("rollout-") || candidate.extension().and_then(|value| value.to_str()) != Some("jsonl") {
        return Err("Codex rollout path is not a rollout JSONL file.".to_owned());
    }
    let size = candidate
        .metadata()
        .map_err(|error| format!("Could not inspect this Codex rollout: {error}"))?
        .len();
    if size > MAX_ROLLOUT_BYTES {
        return Err("Codex rollout is too large to import safely.".to_owned());
    }
    Ok(candidate)
}

fn parse_timestamp_ms(value: Option<&str>) -> Option<i64> {
    value.and_then(|timestamp| chrono::DateTime::parse_from_rfc3339(timestamp).ok())
        .map(|timestamp| timestamp.timestamp_millis())
}

fn quoted_value_after(input: &str, marker: &str) -> Option<String> {
    let mut tail = input.get(input.find(marker)? + marker.len()..)?.trim_start();
    if tail.starts_with(':') {
        tail = tail[1..].trim_start();
    }
    if tail.starts_with('"') {
        let mut escaped = false;
        for (index, character) in tail.char_indices().skip(1) {
            if character == '"' && !escaped {
                return serde_json::from_str::<String>(&tail[..=index]).ok();
            }
            escaped = character == '\\' && !escaped;
            if character != '\\' {
                escaped = false;
            }
        }
    }
    if let Some(rest) = tail.strip_prefix('\'') {
        let mut result = String::new();
        let mut escaped = false;
        for character in rest.chars() {
            if character == '\'' && !escaped {
                return Some(result);
            }
            if escaped {
                result.push(character);
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else {
                result.push(character);
            }
        }
    }
    None
}

fn command_from_tool_input(input: &str) -> Option<String> {
    if let Ok(value) = serde_json::from_str::<Value>(input) {
        if let Some(command) = value.get("cmd").and_then(Value::as_str) {
            return Some(command.to_owned());
        }
        if let Some(command) = value.get("command").and_then(Value::as_str) {
            return Some(command.to_owned());
        }
        if let Some(command) = value.get("command").and_then(Value::as_array) {
            let parts = command.iter().map(Value::as_str).collect::<Option<Vec<_>>>()?;
            return Some(parts.join(" "));
        }
    }
    ["\"cmd\"", "cmd:", "cmd", "\"command\"", "command:"]
        .iter()
        .find_map(|marker| quoted_value_after(input, marker))
        .map(|command| command.trim().to_owned())
        .filter(|command| !command.is_empty())
}

fn output_text(value: &Value) -> Option<String> {
    let text = match value {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts.iter().filter_map(|part| {
            part.get("text").and_then(Value::as_str)
                .or_else(|| part.get("output_text").and_then(Value::as_str))
        }).collect::<Vec<_>>().join("\n"),
        Value::Object(object) => object.get("text").and_then(Value::as_str)
            .or_else(|| object.get("output").and_then(Value::as_str))
            .unwrap_or_default()
            .to_owned(),
        _ => String::new(),
    };
    let text = text.trim();
    if text.is_empty() {
        None
    } else {
        Some(text.chars().take(MAX_COMMAND_OUTPUT_CHARS).collect())
    }
}

fn output_exit_code(output: &str) -> Option<i64> {
    for marker in ["\"exit_code\":", "\"exitCode\":", "Process exited with code "] {
        if let Some(tail) = output.split_once(marker).map(|(_, tail)| tail.trim_start()) {
            let digits: String = tail.chars()
                .take_while(|character| character.is_ascii_digit() || *character == '-')
                .collect();
            if let Ok(code) = digits.parse() {
                return Some(code);
            }
        }
    }
    None
}

fn rollout_turn_id(record: &Value) -> Option<String> {
    record.get("internal_chat_message_metadata_passthrough")
        .and_then(|metadata| metadata.get("turn_id"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| record.get("turn_id").and_then(Value::as_str).map(str::to_owned))
}

fn apply_rollout_record(record: Value, cache: &mut RolloutCommandCache) {
    if record.get("type").and_then(Value::as_str) != Some("response_item") {
        return;
    }
    let Some(payload) = record.get("payload") else { return };
    let item_type = payload.get("type").and_then(Value::as_str).unwrap_or_default();
    if matches!(item_type, "custom_tool_call" | "function_call") {
        let name = payload.get("name").and_then(Value::as_str).unwrap_or_default();
        if !matches!(name, "exec" | "exec_command" | "functions.exec_command") {
            return;
        }
        let input = payload.get("input").or_else(|| payload.get("arguments"));
        let Some(input) = input.and_then(|value| {
            value.as_str().map(str::to_owned).or_else(|| serde_json::to_string(value).ok())
        }) else { return };
        let Some(command) = command_from_tool_input(&input) else { return };
        let Some(id) = payload.get("call_id").or_else(|| payload.get("id")).and_then(Value::as_str) else { return };
        let created_at = record.get("timestamp").and_then(Value::as_str).map(str::to_owned);
        cache.pending.insert(id.to_owned(), PendingRolloutCommand {
            started_at_ms: parse_timestamp_ms(created_at.as_deref()),
            command: models::CodexRolloutCommand {
                id: id.to_owned(),
                turn_id: rollout_turn_id(&record),
                command,
                output: None,
                created_at,
                duration_ms: None,
                exit_code: None,
            },
        });
    } else if matches!(item_type, "custom_tool_call_output" | "function_call_output") {
        let Some(id) = payload.get("call_id").or_else(|| payload.get("id")).and_then(Value::as_str) else { return };
        let Some(mut item) = cache.pending.remove(id) else { return };
        let output = payload.get("output").and_then(output_text);
        item.command.exit_code = output.as_deref().and_then(output_exit_code);
        item.command.output = output;
        let ended_at = parse_timestamp_ms(record.get("timestamp").and_then(Value::as_str));
        item.command.duration_ms = ended_at.zip(item.started_at_ms)
            .map(|(end, start)| end.saturating_sub(start) as u64);
        cache.completed.push(item.command);
    }
}

fn parse_rollout_commands(path: &Path) -> Result<Vec<models::CodexRolloutCommand>, String> {
    let file = File::open(path).map_err(|error| format!("Could not read this Codex rollout: {error}"))?;
    let cache_map = ROLLOUT_COMMAND_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let mut cache_map = cache_map.lock().map_err(|_| "Codex rollout cache is unavailable.")?;
    let cache = cache_map.entry(path.to_owned()).or_default();
    let file_length = file.metadata()
        .map_err(|error| format!("Could not inspect this Codex rollout: {error}"))?
        .len();
    if cache.offset > file_length {
        *cache = RolloutCommandCache::default();
    }
    let mut reader = BufReader::new(file);
    reader.seek(SeekFrom::Start(cache.offset))
        .map_err(|error| format!("Could not seek this Codex rollout: {error}"))?;
    loop {
        let line_start = reader.stream_position()
            .map_err(|error| format!("Could not inspect this Codex rollout: {error}"))?;
        let mut line = String::new();
        let bytes = reader.read_line(&mut line)
            .map_err(|error| format!("Could not read this Codex rollout: {error}"))?;
        if bytes == 0 {
            cache.offset = line_start;
            break;
        }
        match serde_json::from_str::<Value>(&line) {
            Ok(record) => {
                apply_rollout_record(record, cache);
                cache.offset = reader.stream_position()
                    .map_err(|error| format!("Could not inspect this Codex rollout: {error}"))?;
            }
            Err(_) if !line.ends_with('\n') => {
                cache.offset = line_start;
                break;
            }
            Err(_) => {
                cache.offset = reader.stream_position()
                    .map_err(|error| format!("Could not inspect this Codex rollout: {error}"))?;
            }
        }
    }
    let mut completed = cache.completed.clone();
    completed.extend(cache.pending.values().map(|item| item.command.clone()));
    completed.sort_by(|left, right| left.created_at.cmp(&right.created_at));
    Ok(completed)
}

#[tauri::command]
pub fn read_codex_rollout_commands(
    rollout_path: String,
) -> Result<Vec<models::CodexRolloutCommand>, String> {
    parse_rollout_commands(&validated_rollout_path(&rollout_path)?)
}

#[tauri::command]
pub fn start_agent_runtime(
    app: AppHandle,
    project_path: String,
    task_id: Option<String>,
    profile_id: Option<String>,
    runtimes: State<'_, EnvironmentRuntimeRegistry>,
    repository: State<'_, XiaoRepository>,
) -> Result<StartResult, String> {
    let task_id = task_id.as_deref();
    let context = resolve_execution_context(&repository, &project_path, task_id)?;
    let profile =
        repository.runtime_codex_profile(&project_path, task_id, profile_id.as_deref())?;
    runtimes.start_with_profile(app, &context.environment.id, &profile)
}

#[tauri::command]
pub fn stop_agent_runtime(
    project_path: String,
    task_id: Option<String>,
    runtimes: State<'_, EnvironmentRuntimeRegistry>,
    lsp: State<'_, LspManager>,
    repository: State<'_, XiaoRepository>,
) -> Result<(), String> {
    let context = resolve_execution_context(&repository, &project_path, task_id.as_deref())?;
    runtimes.stop(&context.environment.id)?;
    lsp.stop_environment(&context.environment.id)
}

#[tauri::command]
pub async fn agent_request(
    method: String,
    mut params: Value,
    project_path: Option<String>,
    task_id: Option<String>,
    runtimes: State<'_, EnvironmentRuntimeRegistry>,
    repository: State<'_, XiaoRepository>,
) -> Result<Value, String> {
    validate_renderer_agent_request(&method, &params)?;
    let project_path = project_path
        .as_deref()
        .ok_or("This agent request requires a Xiao project context.")?;
    let task_id = task_id
        .as_deref()
        .ok_or("This agent request requires a persisted Xiao task.")?;
    let context = resolve_execution_context(&repository, project_path, Some(task_id))?;
    if method_uses_execution_root(&method) {
        if method == "command/exec" {
            validate_direct_command(&params)?;
        }
        strip_execution_path_fields(&mut params);
        apply_execution_root(&method, &mut params, &context.execution_root)?;
    }
    if !matches!(
        method.as_str(),
        "thread/turns/list" | "thread/archive" | "thread/unarchive"
    ) {
        if let Some(thread_id) = params.get("threadId").and_then(Value::as_str) {
            runtimes.require_thread_task(
                &context.environment.id,
                thread_id,
                &context.project_path,
                task_id,
                &context.execution_root,
            )?;
        }
    }
    runtimes
        .request(&context.environment.id, method, params)
        .await
}

fn validate_renderer_agent_request(method: &str, params: &Value) -> Result<(), String> {
    if native_run_method(method) {
        return Err(format!(
            "Agent method `{method}` is owned by the native Xiao RunService."
        ));
    }
    if !renderer_agent_method(method) {
        return Err(format!(
            "Agent method `{method}` is not available to the Xiao renderer."
        ));
    }
    if !method_uses_execution_root(method) && contains_execution_path_fields(params) {
        return Err(format!(
            "Agent method `{method}` cannot accept frontend-provided execution paths."
        ));
    }
    Ok(())
}

fn renderer_agent_method(method: &str) -> bool {
    matches!(
        method,
        "app/list"
            | "command/exec"
            | "fuzzyFileSearch"
            | "mcpServerStatus/list"
            | "plugin/install"
            | "plugin/list"
            | "plugin/uninstall"
            | "skills/config/write"
            | "skills/list"
            | "thread/list"
            | "thread/turns/list"
            | "thread/archive"
            | "thread/unarchive"
            | "thread/compact/start"
            | "thread/goal/clear"
            | "thread/goal/set"
            | "thread/rollback"
            | "thread/settings/update"
    )
}

fn native_run_method(method: &str) -> bool {
    method.starts_with("turn/")
        || matches!(
            method,
            "thread/start"
                | "thread/resume"
                | "thread/inject_items"
                | "thread/delete"
                | "thread/fork"
        )
}

fn method_uses_execution_root(method: &str) -> bool {
    matches!(
        method,
        "turn/start"
            | "command/exec"
            | "fuzzyFileSearch"
            | "skills/list"
            | "plugin/list"
            | "mcpServerStatus/list"
    )
}

fn contains_execution_path_fields(params: &Value) -> bool {
    match params {
        Value::Object(object) => object.iter().any(|(key, value)| {
            matches!(key.as_str(), "cwd" | "cwds" | "roots" | "writableRoots")
                || contains_execution_path_fields(value)
        }),
        Value::Array(values) => values.iter().any(contains_execution_path_fields),
        _ => false,
    }
}

fn validate_direct_command(params: &Value) -> Result<(), String> {
    let object = params
        .as_object()
        .ok_or("command/exec parameters must be an object.")?;
    if object
        .keys()
        .any(|key| !matches!(key.as_str(), "command" | "cwd" | "timeoutMs"))
    {
        return Err("Direct command execution contains unsupported parameters.".to_owned());
    }
    if object
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .is_none_or(|timeout| timeout == 0 || timeout > 120_000)
    {
        return Err(
            "Direct command execution requires a timeout of at most 120 seconds.".to_owned(),
        );
    }
    let command = object
        .get("command")
        .and_then(Value::as_array)
        .ok_or("command/exec requires a command array.")?;
    let command = command
        .iter()
        .map(Value::as_str)
        .collect::<Option<Vec<_>>>()
        .ok_or("command/exec command arguments must be strings.")?;
    if command != ["gh", "pr", "create", "--draft", "--fill"] {
        return Err(
            "Direct command execution is limited to Xiao's confirmed draft-PR action.".to_owned(),
        );
    }
    Ok(())
}

fn strip_execution_path_fields(value: &mut Value) {
    match value {
        Value::Object(object) => {
            object.retain(|key, _| {
                !matches!(key.as_str(), "cwd" | "cwds" | "roots" | "writableRoots")
            });
            object.values_mut().for_each(strip_execution_path_fields);
        }
        Value::Array(values) => values.iter_mut().for_each(strip_execution_path_fields),
        _ => {}
    }
}

fn apply_execution_root(
    method: &str,
    params: &mut Value,
    execution_root: &str,
) -> Result<(), String> {
    let object = params
        .as_object_mut()
        .ok_or("Agent request parameters must be an object.")?;
    match method {
        "turn/start" => {
            let policy = object
                .get_mut("sandboxPolicy")
                .and_then(Value::as_object_mut)
                .ok_or("turn/start requires an explicit sandbox policy.")?;
            match policy.get("type").and_then(Value::as_str) {
                Some("workspaceWrite") => {
                    policy.insert(
                        "writableRoots".to_owned(),
                        Value::Array(vec![Value::String(execution_root.to_owned())]),
                    );
                }
                Some("readOnly" | "dangerFullAccess") => {
                    policy.remove("writableRoots");
                }
                _ => return Err("turn/start contains an unsupported sandbox policy.".to_owned()),
            }
        }
        "command/exec" => {
            object.insert("cwd".to_owned(), Value::String(execution_root.to_owned()));
        }
        "fuzzyFileSearch" => {
            object.insert(
                "roots".to_owned(),
                Value::Array(vec![Value::String(execution_root.to_owned())]),
            );
        }
        "skills/list" | "plugin/list" | "mcpServerStatus/list" => {
            object.insert(
                "cwds".to_owned(),
                Value::Array(vec![Value::String(execution_root.to_owned())]),
            );
        }
        _ => {
            return Err(format!(
                "Agent method `{method}` has no execution-root policy."
            ))
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn read_agent_account(
    project_path: String,
    task_id: Option<String>,
    runtimes: State<'_, EnvironmentRuntimeRegistry>,
    repository: State<'_, XiaoRepository>,
) -> Result<models::AgentAccountSummary, String> {
    let context = resolve_execution_context(&repository, &project_path, task_id.as_deref())?;
    let runtime = runtimes.runtime(&context.environment.id)?;
    service::read_account(&runtime).await
}

#[tauri::command]
pub async fn read_agent_usage(
    project_path: String,
    task_id: Option<String>,
    runtimes: State<'_, EnvironmentRuntimeRegistry>,
    repository: State<'_, XiaoRepository>,
) -> Result<models::AgentAccountUsage, String> {
    let context = resolve_execution_context(&repository, &project_path, task_id.as_deref())?;
    let runtime = runtimes.runtime(&context.environment.id)?;
    service::read_account_usage(&runtime).await
}

#[tauri::command]
pub async fn read_agent_rate_limits(
    project_path: String,
    task_id: Option<String>,
    runtimes: State<'_, EnvironmentRuntimeRegistry>,
    repository: State<'_, XiaoRepository>,
) -> Result<models::AgentRateLimitsResponse, String> {
    let context = resolve_execution_context(&repository, &project_path, task_id.as_deref())?;
    let runtime = runtimes.runtime(&context.environment.id)?;
    service::read_account_rate_limits(&runtime).await
}

#[tauri::command]
pub async fn list_agent_models(
    project_path: String,
    task_id: Option<String>,
    runtimes: State<'_, EnvironmentRuntimeRegistry>,
    repository: State<'_, XiaoRepository>,
) -> Result<Vec<models::AgentModelSummary>, String> {
    let context = resolve_execution_context(&repository, &project_path, task_id.as_deref())?;
    let runtime = runtimes.runtime(&context.environment.id)?;
    service::list_models(&runtime).await
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{
        apply_execution_root, command_from_tool_input, contains_execution_path_fields,
        native_run_method, output_text,
        renderer_agent_method, strip_execution_path_fields, validate_direct_command,
        validate_renderer_agent_request,
    };

    #[test]
    fn native_root_overrides_frontend_cwd_and_search_roots() {
        let mut command = json!({ "command": ["git", "status"], "cwd": "C:/escape" });
        apply_execution_root("command/exec", &mut command, "C:/owned/root").unwrap();
        assert_eq!(command["cwd"], "C:/owned/root");

        let mut search = json!({ "query": "x", "roots": ["C:/escape"] });
        apply_execution_root("fuzzyFileSearch", &mut search, "C:/owned/root").unwrap();
        assert_eq!(search["roots"], json!(["C:/owned/root"]));
    }

    #[test]
    fn extracts_nested_exec_commands_from_rollout_tool_calls() {
        let input = r#"const r = await tools.exec_command({cmd:"npm test -- --run","workdir":"D:\\Project Archive\\xiao-workbench"}); text(r.output);"#;
        assert_eq!(
            command_from_tool_input(input).as_deref(),
            Some("npm test -- --run")
        );
        assert_eq!(
            command_from_tool_input(r#"{"cmd":"cargo check","yield_time_ms":30000}"#)
                .as_deref(),
            Some("cargo check")
        );
    }

    #[test]
    fn reads_text_blocks_from_rollout_command_outputs() {
        let output = json!([
            { "type": "input_text", "text": "Script completed\n" },
            { "type": "input_text", "text": "Output:\npassed" }
        ]);
        assert_eq!(
            output_text(&output).as_deref(),
            Some("Script completed\n\nOutput:\npassed")
        );
    }

    #[test]
    fn renderer_cannot_invoke_native_run_or_thread_lifecycle_methods() {
        for method in [
            "turn/start",
            "turn/steer",
            "turn/interrupt",
            "thread/start",
            "thread/resume",
            "thread/inject_items",
            "thread/delete",
        ] {
            assert!(native_run_method(method), "{method} should be native-owned");
        }
        assert!(!native_run_method("thread/settings/update"));
        assert!(!native_run_method("thread/compact/start"));
    }

    #[test]
    fn renderer_agent_method_allowlist_covers_current_frontend_calls() {
        for method in [
            "app/list",
            "command/exec",
            "fuzzyFileSearch",
            "mcpServerStatus/list",
            "plugin/install",
            "plugin/list",
            "plugin/uninstall",
            "skills/config/write",
            "skills/list",
            "thread/archive",
            "thread/list",
            "thread/turns/list",
            "thread/unarchive",
            "thread/compact/start",
            "thread/goal/clear",
            "thread/goal/set",
            "thread/rollback",
            "thread/settings/update",
        ] {
            assert!(renderer_agent_method(method), "{method} should be allowed");
            assert!(
                validate_renderer_agent_request(method, &json!({})).is_ok(),
                "{method} should pass renderer validation"
            );
        }
    }

    #[test]
    fn renderer_cannot_bypass_execution_root_with_filesystem_or_process_methods() {
        for (method, params) in [
            ("fs/readFile", json!({ "path": "C:/escape/secret.txt" })),
            ("fs/writeFile", json!({ "path": "C:/escape/output.txt" })),
            ("fs/remove", json!({ "path": "C:/escape" })),
            (
                "fs/copy",
                json!({
                    "sourcePath": "C:/escape/source.txt",
                    "destinationPath": "C:/escape/destination.txt"
                }),
            ),
            (
                "process/spawn",
                json!({ "command": ["cmd", "/c", "whoami"], "cwd": "C:/escape" }),
            ),
        ] {
            let error = validate_renderer_agent_request(method, &params).unwrap_err();
            assert!(
                error.contains("not available to the Xiao renderer"),
                "unexpected rejection for {method}: {error}"
            );
        }
    }

    #[test]
    fn direct_commands_are_limited_to_the_confirmed_draft_pr_action() {
        validate_direct_command(&json!({
            "command": ["gh", "pr", "create", "--draft", "--fill"],
            "cwd": "C:/renderer-value",
            "timeoutMs": 120_000
        }))
        .unwrap();
        assert!(validate_direct_command(&json!({
            "command": ["cmd", "/c", "echo unsafe"],
            "timeoutMs": 120_000
        }))
        .is_err());
        assert!(validate_direct_command(&json!({
            "command": ["gh", "pr", "create", "--draft", "--fill"],
            "timeoutMs": 120_000,
            "env": { "PATH": "C:/escape" }
        }))
        .is_err());
    }

    #[test]
    fn native_root_strips_nested_renderer_paths() {
        let mut params = json!({
            "cwd": "C:/escape",
            "nested": { "roots": ["C:/escape"], "keep": true }
        });
        strip_execution_path_fields(&mut params);
        apply_execution_root("command/exec", &mut params, "C:/owned/root").unwrap();
        assert_eq!(params["cwd"], "C:/owned/root");
        assert_eq!(params["nested"], json!({ "keep": true }));
    }

    #[test]
    fn native_root_overrides_workspace_write_and_removes_irrelevant_roots() {
        let mut workspace_write = json!({
            "sandboxPolicy": { "type": "workspaceWrite", "writableRoots": ["C:/escape"] }
        });
        apply_execution_root("turn/start", &mut workspace_write, "C:/owned/root").unwrap();
        assert_eq!(
            workspace_write["sandboxPolicy"]["writableRoots"],
            json!(["C:/owned/root"])
        );

        let mut read_only = json!({
            "sandboxPolicy": { "type": "readOnly", "writableRoots": ["C:/escape"] }
        });
        apply_execution_root("turn/start", &mut read_only, "C:/owned/root").unwrap();
        assert!(read_only["sandboxPolicy"].get("writableRoots").is_none());
    }

    #[test]
    fn unscoped_agent_methods_cannot_smuggle_execution_paths() {
        assert!(contains_execution_path_fields(
            &json!({ "cwd": "C:/escape" })
        ));
        assert!(contains_execution_path_fields(&json!({
            "sandboxPolicy": { "writableRoots": ["C:/escape"] }
        })));
        assert!(contains_execution_path_fields(&json!({
            "nested": { "cwd": "C:/escape" }
        })));
        assert!(!contains_execution_path_fields(
            &json!({ "threadId": "thread" })
        ));
    }
}
