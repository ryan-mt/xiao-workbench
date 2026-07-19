use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const HANDOFF_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportHandoffRequest {
    pub project_path: String,
    pub task_id: String,
    pub destination_path: String,
    #[serde(default)]
    pub attachment_paths: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportHandoffRequest {
    pub project_path: String,
    pub bundle_path: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportHandoffResult {
    pub destination_path: String,
    pub bundle_sha256: String,
    pub byte_length: u64,
    pub entry_count: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportHandoffResult {
    pub task_id: String,
    pub run_id: String,
    pub bundle_sha256: String,
    pub imported_at: i64,
    pub already_imported: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HandoffBundle {
    pub manifest: HandoffManifest,
    pub entries: Vec<HandoffEntry>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HandoffManifest {
    pub schema_version: u32,
    pub created_at: i64,
    pub source_task_id: String,
    pub source_run_id: Option<String>,
    pub entries: Vec<HandoffManifestEntry>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HandoffManifestEntry {
    pub path: String,
    pub media_type: String,
    pub byte_length: usize,
    pub sha256: String,
    pub required: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HandoffEntry {
    pub path: String,
    pub media_type: String,
    pub byte_length: usize,
    pub sha256: String,
    pub encoding: String,
    pub content: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HandoffTaskPayload {
    pub source_task_id: String,
    pub title: String,
    pub created_at: i64,
    pub goal: Option<Value>,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub mode: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HandoffRuntimePayload {
    pub source_run_id: Option<String>,
    pub status: Option<String>,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub service_tier: Option<String>,
    pub mode: String,
    pub sandbox_mode: String,
    pub cli_version: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HandoffContinuationPayload {
    pub summary: String,
    pub suggested_prompt: String,
}

#[derive(Debug, Clone)]
pub(crate) struct ValidatedHandoff {
    pub bundle_sha256: String,
    pub source_task_id: String,
    pub source_run_id: Option<String>,
    pub task: HandoffTaskPayload,
    pub runtime: HandoffRuntimePayload,
    pub continuation: HandoffContinuationPayload,
    pub transcript: Vec<Value>,
}
