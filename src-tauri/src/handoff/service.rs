use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::LazyLock;
use std::time::{SystemTime, UNIX_EPOCH};

use regex::{Regex, RegexBuilder};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::execution::service::resolve_execution_context;
use crate::runs::models::{RunEventRecord, RunRecord};
use crate::runs::repository::new_uuid_v7;
use crate::xiao::models::XiaoTaskDocument;
use crate::xiao::repository::XiaoRepository;

use super::models::{
    ExportHandoffRequest, ExportHandoffResult, HandoffBundle, HandoffContinuationPayload,
    HandoffEntry, HandoffManifest, HandoffManifestEntry, HandoffRuntimePayload, HandoffTaskPayload,
    ImportHandoffRequest, ImportHandoffResult, ValidatedHandoff, HANDOFF_SCHEMA_VERSION,
};

const MAX_BUNDLE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_ENTRY_BYTES: usize = 4 * 1024 * 1024;
const MAX_DECODED_BYTES: usize = 12 * 1024 * 1024;
const MAX_ENTRIES: usize = 64;
pub(crate) const MAX_ATTACHMENTS: usize = 16;
const MAX_TIMELINE_ENTRIES: usize = 10_000;
const MAX_TIMELINE_BYTES: usize = 8 * 1024 * 1024;
const MAX_EVENTS_PER_RUN: usize = 10_000;
const MAX_TOTAL_EVENTS: usize = 50_000;
const TIMELINE_PAGE_SIZE: usize = 200;
const EVENT_PAGE_SIZE: usize = 200;

const REQUIRED_ENTRY_PATHS: [&str; 5] = [
    "task.json",
    "transcript.json",
    "continuation.json",
    "changes.json",
    "runtime.json",
];

static SECRET_ASSIGNMENT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?i)\b(api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|token|password|secret|credential|private[_-]?key|connection[_-]?string)[\"']?\s*[:=]\s*[\"']?[^\s\"',;}]+"#,
    )
    .expect("handoff secret regex must compile")
});
static ENV_SECRET_ASSIGNMENT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?i)\b([A-Z][A-Z0-9_]*(?:_API_KEY|_TOKEN|_PASSWORD|_SECRET|_PRIVATE_KEY|_SECRET_ACCESS_KEY|_CONNECTION_STRING))\s*[:=]\s*[\"']?[^\s\"',;}]+"#,
    )
    .expect("handoff environment secret regex must compile")
});
static AUTHORIZATION_SECRET: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(authorization\s*:\s*(?:basic|bearer)\s+)[A-Za-z0-9._~+/=-]+")
        .expect("handoff authorization regex must compile")
});
static BEARER_SECRET: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(bearer\s+)[A-Za-z0-9._~+/=-]+").expect("handoff bearer regex must compile")
});
static URL_CREDENTIALS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)\b([a-z][a-z0-9+.-]*://)[^/@\s\"']+:[^/@\s\"']+@"#)
        .expect("handoff URL credential regex must compile")
});
static PRIVATE_KEY_BLOCK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?s)-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?-----END [A-Z0-9 ]*PRIVATE KEY-----")
        .expect("handoff private key regex must compile")
});
static COMMON_TOKEN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|npm_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{20,}|sk_live_[A-Za-z0-9]{12,})\b",
    )
    .expect("handoff common token regex must compile")
});
static OPENAI_SECRET: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\bsk-[A-Za-z0-9_-]{8,}\b").expect("handoff key regex must compile")
});
static PRIVATE_PATH: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?i)(?:[A-Z]:[\\/]|\\\\[^\\/\s\"']+[\\/]|/(?:Users|home|tmp|var|opt|etc|root|srv|mnt|Volumes|private|workspace)/)[^\s\"']+"#,
    )
    .expect("handoff path regex must compile")
});

pub fn export_handoff(
    repository: &XiaoRepository,
    request: ExportHandoffRequest,
) -> Result<ExportHandoffResult, String> {
    if request.attachment_paths.len() > MAX_ATTACHMENTS {
        return Err(format!(
            "A handoff can include at most {MAX_ATTACHMENTS} attachments."
        ));
    }
    let document = repository
        .load_workspace(&request.project_path, false)?
        .ok_or("The Xiao workspace is not persisted.")?;
    let task = document
        .tasks
        .iter()
        .find(|task| task.id == request.task_id)
        .ok_or("The selected Xiao task does not exist.")?;
    let execution =
        resolve_execution_context(repository, &request.project_path, Some(&request.task_id))?;
    let timeline = load_complete_timeline(repository, &request.project_path, &request.task_id)?;
    let runs = repository.list_runs(&request.project_path, Some(&request.task_id), Some(100))?;
    let latest_run = runs.first();
    let mut run_events = Vec::new();
    for run in &runs {
        run_events.extend(load_complete_run_events(repository, &run.id)?);
        if run_events.len() > MAX_TOTAL_EVENTS {
            return Err("The task has too many run events for one handoff.".to_owned());
        }
    }
    let transcript = visible_transcript(&timeline, &execution.execution_root);
    let continuation = continuation_payload(task, &transcript, &execution.execution_root);
    let task_payload = HandoffTaskPayload {
        source_task_id: task.id.clone(),
        title: sanitize_string(&task.title, &execution.execution_root),
        created_at: task.created_at,
        goal: task
            .goal
            .as_ref()
            .map(|goal| sanitize_value(goal, &execution.execution_root, None, 0)),
        model: task.model.clone(),
        reasoning_effort: task.reasoning_effort.clone(),
        mode: safe_mode(&task.mode),
    };
    let runtime = runtime_payload(latest_run);
    let changes = summarize_changes(&run_events, &execution.execution_root);

    let mut entries = vec![
        json_entry("task.json", &task_payload, true)?,
        json_entry("transcript.json", &transcript, true)?,
        json_entry("continuation.json", &continuation, true)?,
        json_entry("changes.json", &changes, true)?,
        json_entry("runtime.json", &runtime, true)?,
    ];
    if task.acceptance_contract.is_some()
        || latest_run.is_some_and(|run| run.acceptance_contract_snapshot.is_some())
    {
        let acceptance = json!({
            "taskContract": task.acceptance_contract,
            "runSnapshot": latest_run.and_then(|run| run.acceptance_contract_snapshot.as_ref()),
        });
        entries.push(json_entry(
            "acceptance.json",
            &sanitize_value(&acceptance, &execution.execution_root, None, 0),
            false,
        )?);
    }
    if let Some(run) = latest_run {
        let evidence = repository.list_verification_evidence(&run.id, Some(20))?;
        if !evidence.attempts.is_empty() {
            entries.push(json_entry(
                "evidence.json",
                &sanitize_value(
                    &serde_json::to_value(evidence).map_err(|error| {
                        format!("Could not encode verification evidence: {error}")
                    })?,
                    &execution.execution_root,
                    None,
                    0,
                ),
                false,
            )?);
        }
    }
    entries.extend(attachment_entries(
        &execution.execution_root,
        &request.attachment_paths,
    )?);
    if entries.len() > MAX_ENTRIES {
        return Err("The handoff contains too many archive entries.".to_owned());
    }
    let decoded_bytes = entries.iter().try_fold(0_usize, |total, entry| {
        total
            .checked_add(entry.byte_length)
            .ok_or("The handoff entry size overflowed.")
    })?;
    if decoded_bytes > MAX_DECODED_BYTES {
        return Err("The selected handoff data exceeds the 12 MiB decoded limit.".to_owned());
    }

    let manifest = HandoffManifest {
        schema_version: HANDOFF_SCHEMA_VERSION,
        created_at: now_millis()?,
        source_task_id: task.id.clone(),
        source_run_id: latest_run.map(|run| run.id.clone()),
        entries: entries
            .iter()
            .map(|entry| HandoffManifestEntry {
                path: entry.path.clone(),
                media_type: entry.media_type.clone(),
                byte_length: entry.byte_length,
                sha256: entry.sha256.clone(),
                required: REQUIRED_ENTRY_PATHS.contains(&entry.path.as_str()),
            })
            .collect(),
    };
    let bundle = HandoffBundle { manifest, entries };
    let bytes = serde_json::to_vec_pretty(&bundle)
        .map_err(|error| format!("Could not serialize Xiao handoff: {error}"))?;
    if bytes.len() as u64 > MAX_BUNDLE_BYTES {
        return Err("The serialized handoff exceeds the 32 MiB archive limit.".to_owned());
    }
    let bundle_sha256 = sha256_hex(&bytes);
    let destination = validate_destination(&request.destination_path)?;
    write_new_file_atomically(&destination, &bytes)?;
    Ok(ExportHandoffResult {
        destination_path: destination.to_string_lossy().into_owned(),
        bundle_sha256,
        byte_length: bytes.len() as u64,
        entry_count: bundle.manifest.entries.len(),
    })
}

pub fn import_handoff(
    repository: &XiaoRepository,
    request: ImportHandoffRequest,
) -> Result<ImportHandoffResult, String> {
    let bundle_path = Path::new(&request.bundle_path);
    if !bundle_path.is_absolute() || !bundle_path.is_file() {
        return Err("Choose an existing absolute Xiao handoff file.".to_owned());
    }
    let bytes = read_bounded_file(bundle_path, MAX_BUNDLE_BYTES as usize, "handoff archive")?;
    let bundle_sha256 = sha256_hex(&bytes);
    let bundle: HandoffBundle = serde_json::from_slice(&bytes)
        .map_err(|error| format!("The handoff archive is invalid JSON: {error}"))?;
    let validated = validate_bundle(bundle, bundle_sha256)?;
    repository.import_handoff_lineage(&request.project_path, validated)
}

fn validate_bundle(
    bundle: HandoffBundle,
    bundle_sha256: String,
) -> Result<ValidatedHandoff, String> {
    if bundle.manifest.schema_version != HANDOFF_SCHEMA_VERSION {
        return Err(format!(
            "Unsupported mandatory handoff schema {}.",
            bundle.manifest.schema_version
        ));
    }
    if bundle.entries.len() > MAX_ENTRIES || bundle.manifest.entries.len() != bundle.entries.len() {
        return Err("The handoff manifest entry count is invalid.".to_owned());
    }
    let allowed_required = REQUIRED_ENTRY_PATHS.iter().copied().collect::<HashSet<_>>();
    let mut manifest_by_path = HashMap::new();
    for manifest in &bundle.manifest.entries {
        validate_entry_path(&manifest.path)?;
        if manifest.required && !allowed_required.contains(manifest.path.as_str()) {
            return Err(format!(
                "Unknown mandatory handoff entry `{}`.",
                manifest.path
            ));
        }
        if manifest_by_path
            .insert(manifest.path.clone(), manifest)
            .is_some()
        {
            return Err("The handoff manifest contains duplicate paths.".to_owned());
        }
    }
    for required in REQUIRED_ENTRY_PATHS {
        if !manifest_by_path
            .get(required)
            .is_some_and(|entry| entry.required)
        {
            return Err(format!(
                "The handoff is missing mandatory entry `{required}`."
            ));
        }
    }

    let mut decoded = HashMap::<String, Vec<u8>>::new();
    let mut decoded_bytes = 0_usize;
    for entry in bundle.entries {
        validate_entry_path(&entry.path)?;
        let manifest = manifest_by_path
            .get(&entry.path)
            .ok_or_else(|| format!("Entry `{}` is absent from the manifest.", entry.path))?;
        if entry.encoding != "hex" {
            return Err(format!(
                "Entry `{}` uses an unsupported encoding.",
                entry.path
            ));
        }
        let content = decode_hex(&entry.content)?;
        if content.len() > MAX_ENTRY_BYTES {
            return Err(format!("Entry `{}` exceeds the 4 MiB limit.", entry.path));
        }
        decoded_bytes = decoded_bytes
            .checked_add(content.len())
            .ok_or("The handoff decoded size overflowed.")?;
        if decoded_bytes > MAX_DECODED_BYTES {
            return Err("The handoff exceeds the 12 MiB decoded limit.".to_owned());
        }
        let actual_sha256 = sha256_hex(&content);
        let actual = HandoffManifestEntry {
            path: entry.path.clone(),
            media_type: entry.media_type.clone(),
            byte_length: content.len(),
            sha256: actual_sha256.clone(),
            required: manifest.required,
        };
        if entry.byte_length != content.len()
            || entry.sha256 != actual_sha256
            || **manifest != actual
        {
            return Err(format!(
                "Entry `{}` failed manifest hash validation.",
                entry.path
            ));
        }
        if decoded.insert(entry.path.clone(), content).is_some() {
            return Err("The handoff contains duplicate entry paths.".to_owned());
        }
    }

    let mut task: HandoffTaskPayload = decode_json_entry(&decoded, "task.json")?;
    let mut runtime: HandoffRuntimePayload = decode_json_entry(&decoded, "runtime.json")?;
    let mut continuation: HandoffContinuationPayload =
        decode_json_entry(&decoded, "continuation.json")?;
    let transcript: Vec<Value> = decode_json_entry(&decoded, "transcript.json")?;
    let _: Value = decode_json_entry(&decoded, "changes.json")?;
    if task.source_task_id != bundle.manifest.source_task_id
        || runtime.source_run_id != bundle.manifest.source_run_id
    {
        return Err("The handoff source lineage does not match its manifest.".to_owned());
    }
    if !valid_lineage_id(&task.source_task_id)
        || runtime
            .source_run_id
            .as_deref()
            .is_some_and(|value| !valid_lineage_id(value))
    {
        return Err("The handoff contains an invalid source lineage identifier.".to_owned());
    }
    task.title = sanitize_string(&task.title, "");
    task.goal = task
        .goal
        .as_ref()
        .map(|goal| sanitize_value(goal, "", None, 0));
    task.model = sanitize_optional_metadata(task.model);
    task.reasoning_effort = sanitize_optional_metadata(task.reasoning_effort);
    task.mode = safe_mode(&task.mode);
    runtime.status = sanitize_optional_metadata(runtime.status);
    runtime.model = sanitize_optional_metadata(runtime.model);
    runtime.reasoning_effort = sanitize_optional_metadata(runtime.reasoning_effort);
    runtime.service_tier = sanitize_optional_metadata(runtime.service_tier);
    runtime.mode = safe_mode(&runtime.mode);
    runtime.sandbox_mode = safe_sandbox(&runtime.sandbox_mode);
    runtime.cli_version = sanitize_optional_metadata(runtime.cli_version);
    continuation.summary = sanitize_string(&continuation.summary, "");
    continuation.suggested_prompt = sanitize_string(&continuation.suggested_prompt, "");
    let transcript = visible_transcript(&transcript, "");
    if transcript.len() > MAX_TIMELINE_ENTRIES
        || serde_json::to_vec(&transcript).is_ok_and(|value| value.len() > MAX_TIMELINE_BYTES)
    {
        return Err("The imported transcript exceeds Xiao history limits.".to_owned());
    }
    Ok(ValidatedHandoff {
        bundle_sha256,
        source_task_id: bundle.manifest.source_task_id,
        source_run_id: bundle.manifest.source_run_id,
        task,
        runtime,
        continuation,
        transcript,
    })
}

fn load_complete_timeline(
    repository: &XiaoRepository,
    workspace_path: &str,
    task_id: &str,
) -> Result<Vec<Value>, String> {
    let mut before = None;
    let mut timeline = Vec::new();
    loop {
        let page = repository.load_timeline_page(
            workspace_path,
            task_id,
            before,
            Some(TIMELINE_PAGE_SIZE),
        )?;
        timeline.splice(0..0, page.entries);
        if timeline.len() > MAX_TIMELINE_ENTRIES
            || serde_json::to_vec(&timeline).is_ok_and(|value| value.len() > MAX_TIMELINE_BYTES)
        {
            return Err("The task transcript exceeds handoff history limits.".to_owned());
        }
        if !page.has_more {
            return Ok(timeline);
        }
        before = Some(page.start);
    }
}

fn load_complete_run_events(
    repository: &XiaoRepository,
    run_id: &str,
) -> Result<Vec<RunEventRecord>, String> {
    let mut after = Some(-1_i64);
    let mut events = Vec::new();
    loop {
        let page = repository.list_run_events(run_id, after, Some(EVENT_PAGE_SIZE))?;
        if page.is_empty() {
            return Ok(events);
        }
        after = page.last().map(|event| event.sequence);
        let complete = page.len() < EVENT_PAGE_SIZE;
        events.extend(page);
        if events.len() > MAX_EVENTS_PER_RUN {
            return Err("A Xiao run has too many events for one handoff.".to_owned());
        }
        if complete {
            return Ok(events);
        }
    }
}

fn visible_transcript(timeline: &[Value], root: &str) -> Vec<Value> {
    timeline
        .iter()
        .filter_map(|entry| {
            let entry = entry.as_object()?;
            let kind = entry.get("kind")?.as_str()?;
            if kind != "user" && kind != "result" {
                return None;
            }
            let mut visible = Map::new();
            let id = entry
                .get("id")
                .and_then(Value::as_str)
                .map(|value| sanitize_string(value, root))
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| "imported-entry".to_owned())
                .chars()
                .take(256)
                .collect::<String>();
            visible.insert("id".to_owned(), Value::String(id));
            visible.insert("kind".to_owned(), Value::String(kind.to_owned()));
            if let Some(timestamp) = entry.get("createdAt").and_then(Value::as_i64) {
                visible.insert("createdAt".to_owned(), Value::Number(timestamp.into()));
            }
            for key in ["title", "body", "meta"] {
                if let Some(text) = entry.get(key).and_then(Value::as_str) {
                    visible.insert(key.to_owned(), Value::String(sanitize_string(text, root)));
                }
            }
            let default_status = if kind == "result" { "success" } else { "idle" };
            let status = entry
                .get("status")
                .and_then(Value::as_str)
                .filter(|value| {
                    matches!(*value, "idle" | "active" | "success" | "warning" | "error")
                })
                .unwrap_or(default_status);
            visible.insert("status".to_owned(), Value::String(status.to_owned()));
            Some(Value::Object(visible))
        })
        .collect()
}

fn continuation_payload(
    task: &XiaoTaskDocument,
    transcript: &[Value],
    root: &str,
) -> HandoffContinuationPayload {
    let objective = task
        .goal
        .as_ref()
        .and_then(|goal| goal.get("objective"))
        .and_then(Value::as_str)
        .map(|value| sanitize_string(value, root));
    let latest = transcript.iter().rev().find_map(|entry| {
        (entry.get("kind").and_then(Value::as_str) == Some("result"))
            .then(|| entry.get("body").and_then(Value::as_str))
            .flatten()
            .map(|value| value.chars().take(1_000).collect::<String>())
    });
    let summary = [
        Some(format!("Task: {}", sanitize_string(&task.title, root))),
        objective.map(|value| format!("Goal: {value}")),
        latest.map(|value| format!("Latest result: {value}")),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join("\n\n");
    HandoffContinuationPayload {
        summary,
        suggested_prompt: "Continue this imported task from the sanitized handoff. Verify the current workspace state before making changes.".to_owned(),
    }
}

fn runtime_payload(run: Option<&RunRecord>) -> HandoffRuntimePayload {
    HandoffRuntimePayload {
        source_run_id: run.map(|run| run.id.clone()),
        status: run.map(|run| run.status.as_database().to_owned()),
        model: run.and_then(|run| run.model.clone()),
        reasoning_effort: run.and_then(|run| run.reasoning_effort.clone()),
        service_tier: run.and_then(|run| run.service_tier.clone()),
        mode: run
            .map(|run| safe_mode(&run.mode))
            .unwrap_or_else(|| "default".to_owned()),
        sandbox_mode: run
            .map(|run| safe_sandbox(&run.sandbox_mode))
            .unwrap_or_else(|| "workspace-write".to_owned()),
        cli_version: run.and_then(|run| run.cli_version.clone()),
    }
}

fn summarize_changes(events: &[RunEventRecord], root: &str) -> Value {
    let mut changes = Vec::new();
    for event in events {
        let Some(payload) = event.safe_payload.as_object() else {
            continue;
        };
        let protocol = if event.event_type.starts_with("agent.") {
            Some(payload)
        } else {
            payload.get("protocol").and_then(Value::as_object)
        };
        if let Some(item) = protocol
            .and_then(|message| message.get("params"))
            .and_then(|params| params.get("item"))
            .and_then(Value::as_object)
        {
            if item.get("type").and_then(Value::as_str) == Some("fileChange") {
                for change in item
                    .get("changes")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    let Some(change) = change.as_object() else {
                        continue;
                    };
                    let path = change
                        .get("path")
                        .and_then(Value::as_str)
                        .map(|path| sanitize_string(path, root))
                        .unwrap_or_else(|| "[unknown file]".to_owned());
                    let diff = change
                        .get("diff")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    let (additions, deletions) = count_diff(diff);
                    changes.push(json!({
                        "runId": event.run_id,
                        "sequence": event.sequence,
                        "path": path,
                        "kind": change.get("kind"),
                        "additions": additions,
                        "deletions": deletions,
                        "diffSha256": sha256_hex(diff.as_bytes()),
                    }));
                }
            }
        }
        if let Some(diff) = payload.get("turnDiff").and_then(Value::as_str) {
            let (additions, deletions) = count_diff(diff);
            changes.push(json!({
                "runId": event.run_id,
                "sequence": event.sequence,
                "kind": "turnPatch",
                "additions": additions,
                "deletions": deletions,
                "byteLength": diff.len(),
                "diffSha256": sha256_hex(diff.as_bytes()),
            }));
        }
    }
    Value::Array(changes)
}

fn count_diff(diff: &str) -> (usize, usize) {
    diff.lines().fold((0, 0), |(additions, deletions), line| {
        if line.starts_with('+') && !line.starts_with("+++") {
            (additions + 1, deletions)
        } else if line.starts_with('-') && !line.starts_with("---") {
            (additions, deletions + 1)
        } else {
            (additions, deletions)
        }
    })
}

fn attachment_entries(root: &str, paths: &[String]) -> Result<Vec<HandoffEntry>, String> {
    let root = Path::new(root)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let mut entries = Vec::new();
    let mut seen = HashSet::new();
    for (index, path) in paths.iter().enumerate() {
        let relative = validate_relative_attachment(path)?;
        let canonical = root
            .join(&relative)
            .canonicalize()
            .map_err(|error| format!("Could not read selected attachment `{path}`: {error}"))?;
        if !canonical.starts_with(&root) || !canonical.is_file() {
            return Err(format!("Attachment `{path}` leaves the execution root."));
        }
        let bytes = read_bounded_file(&canonical, MAX_ENTRY_BYTES, "selected attachment")
            .map_err(|error| format!("Attachment `{path}` could not be included: {error}"))?;
        let name = relative
            .file_name()
            .and_then(|value| value.to_str())
            .map(safe_archive_name)
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "attachment.bin".to_owned());
        let archive_path = format!("attachments/{index:02}-{name}");
        if !seen.insert(archive_path.clone()) {
            return Err("Two selected attachments have the same archive path.".to_owned());
        }
        entries.push(binary_entry(
            &archive_path,
            "application/octet-stream",
            &bytes,
            false,
        )?);
    }
    Ok(entries)
}

fn json_entry<T: Serialize>(
    path: &str,
    value: &T,
    _required: bool,
) -> Result<HandoffEntry, String> {
    let bytes = serde_json::to_vec(value)
        .map_err(|error| format!("Could not serialize handoff entry `{path}`: {error}"))?;
    binary_entry(path, "application/json", &bytes, _required)
}

fn binary_entry(
    path: &str,
    media_type: &str,
    bytes: &[u8],
    _required: bool,
) -> Result<HandoffEntry, String> {
    validate_entry_path(path)?;
    if bytes.len() > MAX_ENTRY_BYTES {
        return Err(format!("Handoff entry `{path}` exceeds the 4 MiB limit."));
    }
    Ok(HandoffEntry {
        path: path.to_owned(),
        media_type: media_type.to_owned(),
        byte_length: bytes.len(),
        sha256: sha256_hex(bytes),
        encoding: "hex".to_owned(),
        content: encode_hex(bytes),
    })
}

fn decode_json_entry<T: DeserializeOwned>(
    entries: &HashMap<String, Vec<u8>>,
    path: &str,
) -> Result<T, String> {
    serde_json::from_slice(
        entries
            .get(path)
            .ok_or_else(|| format!("The handoff is missing `{path}`."))?,
    )
    .map_err(|error| format!("Handoff entry `{path}` is invalid: {error}"))
}

fn validate_entry_path(path: &str) -> Result<(), String> {
    if path.is_empty()
        || path.len() > 240
        || path.starts_with('/')
        || path.contains(['\\', ':', '\0'])
        || path
            .split('/')
            .any(|segment| segment.is_empty() || segment == "." || segment == "..")
    {
        return Err(format!("Unsafe handoff archive path `{path}`."));
    }
    Ok(())
}

fn validate_relative_attachment(path: &str) -> Result<PathBuf, String> {
    let candidate = Path::new(path);
    if path.is_empty()
        || candidate.is_absolute()
        || candidate
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(format!(
            "Attachment path `{path}` must be workspace-relative."
        ));
    }
    Ok(candidate.to_path_buf())
}

fn validate_destination(path: &str) -> Result<PathBuf, String> {
    let destination = PathBuf::from(path);
    if !destination.is_absolute() {
        return Err("Choose an absolute destination for the Xiao handoff.".to_owned());
    }
    if destination.exists() {
        return Err("The handoff destination already exists; choose a new file name.".to_owned());
    }
    let parent = destination
        .parent()
        .ok_or("The handoff destination has no parent directory.")?;
    if !parent.is_dir() {
        return Err("The handoff destination directory does not exist.".to_owned());
    }
    Ok(destination)
}

fn read_bounded_file(path: &Path, limit: usize, label: &str) -> Result<Vec<u8>, String> {
    let file = fs::File::open(path).map_err(|error| format!("Could not read {label}: {error}"))?;
    let mut bytes = Vec::new();
    file.take(limit.saturating_add(1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Could not read {label}: {error}"))?;
    if bytes.len() > limit {
        return Err(format!(
            "The {label} exceeds its {} MiB limit.",
            limit / 1_048_576
        ));
    }
    Ok(bytes)
}

fn write_new_file_atomically(destination: &Path, bytes: &[u8]) -> Result<(), String> {
    let temporary = destination.with_extension(format!(
        "{}.{}.tmp",
        destination
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("handoff"),
        new_uuid_v7(),
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| format!("Could not create handoff archive: {error}"))?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("Could not write handoff archive: {error}"))?;
        fs::hard_link(&temporary, destination).map_err(|error| {
            format!("Could not publish handoff archive without overwriting: {error}")
        })?;
        let _ = fs::remove_file(&temporary);
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn sanitize_value(value: &Value, root: &str, key: Option<&str>, depth: usize) -> Value {
    if depth > 12 {
        return Value::String("[truncated]".to_owned());
    }
    if key.is_some_and(sensitive_key) {
        return Value::String("[redacted]".to_owned());
    }
    if key.is_some_and(sensitive_path_key) {
        return Value::String("[private path]".to_owned());
    }
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) => value.clone(),
        Value::String(value) => Value::String(sanitize_string(value, root)),
        Value::Array(values) => Value::Array(
            values
                .iter()
                .take(500)
                .map(|value| sanitize_value(value, root, key, depth + 1))
                .collect(),
        ),
        Value::Object(values) => {
            let mut safe = Map::new();
            for (name, value) in values {
                if sensitive_key(name) {
                    safe.insert(name.clone(), Value::String("[redacted]".to_owned()));
                } else {
                    safe.insert(
                        name.clone(),
                        sanitize_value(value, root, Some(name), depth + 1),
                    );
                }
            }
            Value::Object(safe)
        }
    }
}

fn sanitize_string(value: &str, root: &str) -> String {
    let mut clean = value.to_owned();
    if !root.is_empty() {
        clean = replace_case_insensitive(&clean, root, "[workspace]");
        clean = replace_case_insensitive(&clean, &root.replace('\\', "/"), "[workspace]");
    }
    clean = PRIVATE_KEY_BLOCK
        .replace_all(&clean, "[redacted private key]")
        .into_owned();
    clean = URL_CREDENTIALS
        .replace_all(&clean, "$1[redacted]@")
        .into_owned();
    clean = ENV_SECRET_ASSIGNMENT
        .replace_all(&clean, "$1=[redacted]")
        .into_owned();
    clean = SECRET_ASSIGNMENT
        .replace_all(&clean, "$1=[redacted]")
        .into_owned();
    clean = AUTHORIZATION_SECRET
        .replace_all(&clean, "$1[redacted]")
        .into_owned();
    clean = BEARER_SECRET
        .replace_all(&clean, "$1[redacted]")
        .into_owned();
    clean = COMMON_TOKEN.replace_all(&clean, "[redacted]").into_owned();
    clean = OPENAI_SECRET.replace_all(&clean, "[redacted]").into_owned();
    clean = PRIVATE_PATH
        .replace_all(&clean, "[private path]")
        .into_owned();
    clean.chars().take(64 * 1024).collect()
}

fn replace_case_insensitive(value: &str, needle: &str, replacement: &str) -> String {
    if needle.is_empty() {
        return value.to_owned();
    }
    RegexBuilder::new(&regex::escape(needle))
        .case_insensitive(true)
        .build()
        .map(|pattern| pattern.replace_all(value, replacement).into_owned())
        .unwrap_or_else(|_| value.replace(needle, replacement))
}

fn sensitive_path_key(name: &str) -> bool {
    let normalized = name
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect::<String>();
    normalized == "cwd"
        || normalized.ends_with("path")
        || normalized.ends_with("paths")
        || normalized.ends_with("directory")
        || normalized.ends_with("directories")
}

fn sensitive_key(name: &str) -> bool {
    let normalized = name
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect::<String>();
    matches!(
        normalized.as_str(),
        "authorization"
            | "cookie"
            | "cookies"
            | "password"
            | "credential"
            | "credentials"
            | "privatekey"
            | "encryptedcontent"
            | "connectionstring"
            | "databaseurl"
            | "databaseuri"
            | "dsn"
    ) || normalized.ends_with("token")
        || normalized.ends_with("connectionstring")
        || normalized.ends_with("apikey")
        || normalized.contains("secret")
}

fn valid_lineage_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 512
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
}

fn sanitize_optional_metadata(value: Option<String>) -> Option<String> {
    value
        .map(|value| {
            sanitize_string(&value, "")
                .chars()
                .take(512)
                .collect::<String>()
        })
        .filter(|value| !value.trim().is_empty())
}

fn safe_archive_name(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .take(100)
        .collect()
}

fn safe_mode(value: &str) -> String {
    if value == "plan" { "plan" } else { "default" }.to_owned()
}

fn safe_sandbox(value: &str) -> String {
    match value {
        "read-only" | "workspace-write" | "danger-full-access" => value.to_owned(),
        _ => "workspace-write".to_owned(),
    }
}

fn encode_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn decode_hex(value: &str) -> Result<Vec<u8>, String> {
    let bytes = value.as_bytes();
    if bytes.len() % 2 != 0 {
        return Err("A handoff entry contains malformed hex data.".to_owned());
    }
    bytes
        .chunks_exact(2)
        .map(|pair| {
            let high = hex_nibble(pair[0])?;
            let low = hex_nibble(pair[1])?;
            Ok((high << 4) | low)
        })
        .collect()
}

fn hex_nibble(value: u8) -> Result<u8, String> {
    match value {
        b'0'..=b'9' => Ok(value - b'0'),
        b'a'..=b'f' => Ok(value - b'a' + 10),
        b'A'..=b'F' => Ok(value - b'A' + 10),
        _ => Err("A handoff entry contains malformed hex data.".to_owned()),
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn now_millis() -> Result<i64, String> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    i64::try_from(millis).map_err(|_| "System time exceeds Xiao storage limits.".to_owned())
}

#[cfg(test)]
mod tests {
    use super::{
        decode_hex, encode_hex, sanitize_string, validate_bundle, HandoffBundle, HandoffEntry,
        HandoffManifest, HandoffManifestEntry, HANDOFF_SCHEMA_VERSION,
    };
    use serde_json::json;

    fn entry(
        path: &str,
        value: serde_json::Value,
        required: bool,
    ) -> (HandoffEntry, HandoffManifestEntry) {
        let bytes = serde_json::to_vec(&value).unwrap();
        let sha256 = super::sha256_hex(&bytes);
        (
            HandoffEntry {
                path: path.to_owned(),
                media_type: "application/json".to_owned(),
                byte_length: bytes.len(),
                sha256: sha256.clone(),
                encoding: "hex".to_owned(),
                content: encode_hex(&bytes),
            },
            HandoffManifestEntry {
                path: path.to_owned(),
                media_type: "application/json".to_owned(),
                byte_length: bytes.len(),
                sha256,
                required,
            },
        )
    }

    fn valid_bundle() -> HandoffBundle {
        let values = [
            (
                "task.json",
                json!({
                    "sourceTaskId": "source-task", "title": "Task", "createdAt": 1,
                    "goal": null, "model": null, "reasoningEffort": null, "mode": "default"
                }),
            ),
            ("transcript.json", json!([])),
            (
                "continuation.json",
                json!({ "summary": "Continue", "suggestedPrompt": "Continue" }),
            ),
            ("changes.json", json!([])),
            (
                "runtime.json",
                json!({
                    "sourceRunId": "source-run", "status": "completed", "model": null,
                    "reasoningEffort": null, "serviceTier": null, "mode": "default",
                    "sandboxMode": "workspace-write", "cliVersion": null
                }),
            ),
        ];
        let (entries, manifest_entries): (Vec<_>, Vec<_>) = values
            .into_iter()
            .map(|(path, value)| entry(path, value, true))
            .unzip();
        HandoffBundle {
            manifest: HandoffManifest {
                schema_version: HANDOFF_SCHEMA_VERSION,
                created_at: 1,
                source_task_id: "source-task".to_owned(),
                source_run_id: Some("source-run".to_owned()),
                entries: manifest_entries,
            },
            entries,
        }
    }

    fn replace_json_entry(bundle: &mut HandoffBundle, path: &str, value: serde_json::Value) {
        let bytes = serde_json::to_vec(&value).unwrap();
        let sha256 = super::sha256_hex(&bytes);
        let entry = bundle
            .entries
            .iter_mut()
            .find(|entry| entry.path == path)
            .unwrap();
        entry.byte_length = bytes.len();
        entry.sha256 = sha256.clone();
        entry.content = encode_hex(&bytes);
        let manifest = bundle
            .manifest
            .entries
            .iter_mut()
            .find(|entry| entry.path == path)
            .unwrap();
        manifest.byte_length = bytes.len();
        manifest.sha256 = sha256;
    }

    #[test]
    fn handoff_validation_rejects_path_traversal_invalid_hash_and_unknown_schema() {
        let mut traversal = valid_bundle();
        traversal.manifest.entries[0].path = "../task.json".to_owned();
        traversal.entries[0].path = "../task.json".to_owned();
        assert!(validate_bundle(traversal, "a".repeat(64)).is_err());

        let mut invalid_hash = valid_bundle();
        invalid_hash.entries[0].sha256 = "b".repeat(64);
        assert!(validate_bundle(invalid_hash, "a".repeat(64)).is_err());

        let mut unknown = valid_bundle();
        unknown.manifest.schema_version = HANDOFF_SCHEMA_VERSION + 1;
        assert!(validate_bundle(unknown, "a".repeat(64)).is_err());
    }

    #[test]
    fn handoff_validation_rejects_unknown_mandatory_entries() {
        let mut bundle = valid_bundle();
        let (entry, manifest) = entry("future-required.json", json!({}), true);
        bundle.entries.push(entry);
        bundle.manifest.entries.push(manifest);
        assert!(validate_bundle(bundle, "a".repeat(64)).is_err());
    }

    #[test]
    fn handoff_redaction_removes_credentials_and_absolute_private_paths() {
        let value = concat!(
            "client_secret=client-value AWS_SECRET_ACCESS_KEY=aws-secret ",
            "\"token\": \"quoted-secret\" Authorization: Basic basic-value ",
            "https://user:pass@example.com/ postgres://db-user:db-pass@example.com/db ",
            "github_pat_abcdefghijklmnopqrstuvwxyz1234 ",
            "-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY----- ",
            "C:\\Users\\me\\secret.txt \\\\server\\share\\private.txt /etc/private.conf",
        );
        let sanitized = sanitize_string(value, "C:\\Users\\me\\project");
        for private in [
            "client-value",
            "aws-secret",
            "quoted-secret",
            "basic-value",
            "user:pass",
            "db-user:db-pass",
            "github_pat_",
            "private-material",
            "C:\\Users",
            "server\\share",
            "/etc/private.conf",
        ] {
            assert!(!sanitized.contains(private), "failed to redact {private}");
        }
    }

    #[test]
    fn handoff_redaction_uses_structured_path_keys() {
        let sanitized = super::sanitize_value(
            &json!({
                "cwd": "relative/private",
                "artifactPath": "relative/private.txt",
                "attachmentPaths": ["relative/one", "relative/two"],
                "connectionString": "postgres://user:pass@example.com/db",
                "nestedPath": { "value": "/data/customer/private" },
                "nested": { "safe": "visible" }
            }),
            "",
            None,
            0,
        );
        assert_eq!(sanitized["cwd"], "[private path]");
        assert_eq!(sanitized["artifactPath"], "[private path]");
        assert_eq!(sanitized["attachmentPaths"], "[private path]");
        assert_eq!(sanitized["connectionString"], "[redacted]");
        assert_eq!(sanitized["nestedPath"], "[private path]");
        assert_eq!(sanitized["nested"]["safe"], "visible");
    }

    #[test]
    fn handoff_hex_round_trips_binary_bytes() {
        let bytes = [0, 1, 2, 127, 128, 255];
        assert_eq!(decode_hex(&encode_hex(&bytes)).unwrap(), bytes);
        assert!(decode_hex("â‚¬â‚¬").is_err());
    }

    #[test]
    fn handoff_validation_rejects_oversized_entries() {
        let mut bundle = valid_bundle();
        let bytes = vec![b'x'; super::MAX_ENTRY_BYTES + 1];
        bundle.entries[0].content = encode_hex(&bytes);
        bundle.entries[0].byte_length = bytes.len();
        bundle.entries[0].sha256 = super::sha256_hex(&bytes);
        bundle.manifest.entries[0].byte_length = bytes.len();
        bundle.manifest.entries[0].sha256 = super::sha256_hex(&bytes);
        assert!(validate_bundle(bundle, "a".repeat(64)).is_err());
    }

    #[test]
    fn handoff_import_resanitizes_untrusted_payloads_and_filters_transcript_kinds() {
        let mut bundle = valid_bundle();
        replace_json_entry(
            &mut bundle,
            "task.json",
            json!({
                "sourceTaskId": "source-task", "title": "token=private-value C:\\Users\\me\\task",
                "createdAt": 1, "goal": { "authorization": "Bearer unsafe" },
                "model": "gpt-test", "reasoningEffort": null, "mode": "default"
            }),
        );
        replace_json_entry(
            &mut bundle,
            "transcript.json",
            json!([
                { "id": "command", "kind": "command", "title": "must be dropped" },
                { "id": "result", "kind": "result", "title": "Done", "body": "password=hunter2 /home/me/private" }
            ]),
        );

        let validated = validate_bundle(bundle, "a".repeat(64)).unwrap();
        assert!(!validated.task.title.contains("private-value"));
        assert!(!validated.task.title.contains("C:\\Users"));
        assert_eq!(
            validated.task.goal,
            Some(json!({ "authorization": "[redacted]" }))
        );
        assert_eq!(validated.transcript.len(), 1);
        let encoded = serde_json::to_string(&validated.transcript).unwrap();
        assert!(!encoded.contains("hunter2"));
        assert!(!encoded.contains("/home/me"));
    }

    #[test]
    fn handoff_publish_is_atomic_and_never_overwrites_an_existing_bundle() {
        let directory = std::env::temp_dir().join(format!(
            "xiao-handoff-publish-{}-{}",
            std::process::id(),
            super::new_uuid_v7(),
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let destination = directory.join("task.xiao-handoff");
        super::write_new_file_atomically(&destination, b"first").unwrap();
        assert_eq!(std::fs::read(&destination).unwrap(), b"first");
        assert!(super::write_new_file_atomically(&destination, b"second").is_err());
        assert_eq!(std::fs::read(&destination).unwrap(), b"first");
        std::fs::remove_dir_all(directory).unwrap();
    }
}
