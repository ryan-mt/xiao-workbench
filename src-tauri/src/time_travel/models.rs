use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnCheckpointSummary {
    pub id: String,
    pub run_id: String,
    pub turn_id: String,
    pub prompt: String,
    pub run_status: String,
    pub patch_bytes: usize,
    pub before_fingerprint: String,
    pub after_fingerprint: String,
    pub created_at: i64,
    pub restored_at: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreTurnsRequest {
    pub project_path: String,
    pub task_id: String,
    pub target_checkpoint_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreTurnsResult {
    pub restore_batch_id: String,
    pub restored_checkpoint_ids: Vec<String>,
    pub restored_turn_count: usize,
    pub target_fingerprint: String,
    pub restored_at: i64,
}

#[derive(Debug, Clone)]
pub(crate) struct StoredTurnCheckpoint {
    pub id: String,
    pub run_id: String,
    pub execution_root: String,
    pub patch: String,
    pub patch_sha256: String,
    pub before_fingerprint: String,
    pub after_fingerprint: String,
}
