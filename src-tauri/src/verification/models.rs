#![expect(
    dead_code,
    reason = "M5 persistence records are wired by subsequent implementation slices"
)]

use std::fmt::Write as _;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

pub const ACCEPTANCE_CONTRACT_SCHEMA_VERSION: u32 = 1;
pub const MAX_ACCEPTANCE_CONTRACT_GATES: usize = 32;
pub const MAX_ACCEPTANCE_CONTRACT_JSON_BYTES: usize = 256 * 1024;
pub const MAX_COMMAND_ARGUMENTS: usize = 256;
pub const MAX_COMMAND_ARGV_BYTES: usize = 256 * 1024;
pub const MIN_COMMAND_TIMEOUT_MS: u64 = 1_000;
pub const MAX_COMMAND_TIMEOUT_MS: u64 = 60 * 60 * 1_000;
pub const MAX_EXPECTED_EXIT_CODES: usize = 32;
pub const MAX_PATH_PATTERNS: usize = 128;
pub const MAX_PATH_PATTERN_BYTES: usize = 4 * 1024;

#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcceptanceContractDraft {
    pub name: String,
    pub gates: Vec<AcceptanceGate>,
}

impl AcceptanceContractDraft {
    pub(crate) fn normalize(&self) -> Result<NormalizedAcceptanceContract, String> {
        normalize_contract(&self.name, &self.gates)
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcceptanceContractSnapshot {
    pub schema_version: u32,
    pub name: String,
    pub gates: Vec<AcceptanceGate>,
}

impl AcceptanceContractSnapshot {
    pub(crate) fn validate_canonical(&self) -> Result<NormalizedAcceptanceContract, String> {
        if self.schema_version != ACCEPTANCE_CONTRACT_SCHEMA_VERSION {
            return Err(format!(
                "Unsupported acceptance contract schema version {}.",
                self.schema_version
            ));
        }
        let normalized = normalize_contract(&self.name, &self.gates)?;
        if normalized.snapshot != *self {
            return Err(
                "The acceptance contract snapshot is not canonically normalized.".to_owned(),
            );
        }
        Ok(normalized)
    }

    pub(crate) fn requires_diff_baseline(&self) -> bool {
        self.gates
            .iter()
            .any(|gate| matches!(gate, AcceptanceGate::DiffScope { .. }))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NormalizedAcceptanceContract {
    pub snapshot: AcceptanceContractSnapshot,
    pub canonical_json: String,
    pub content_sha256: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AcceptanceGate {
    Command {
        executable: String,
        argv: Vec<String>,
        timeout_ms: u64,
        expected_exit_codes: Vec<i32>,
    },
    DiffScope {
        allowed_patterns: Vec<String>,
        denied_patterns: Vec<String>,
    },
    Cleanliness {
        allow_staged: bool,
        allow_unstaged: bool,
        allow_untracked: bool,
    },
}

impl AcceptanceGate {
    pub fn gate_type(&self) -> VerificationGateType {
        match self {
            Self::Command { .. } => VerificationGateType::Command,
            Self::DiffScope { .. } => VerificationGateType::DiffScope,
            Self::Cleanliness { .. } => VerificationGateType::Cleanliness,
        }
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcceptanceContractVersionSummary {
    pub version_id: String,
    pub contract_id: String,
    pub version: u32,
    pub schema: u32,
    pub name: String,
    pub gates: Vec<AcceptanceGate>,
    pub hash: String,
    pub created_at: i64,
    pub updated_at: i64,
}

impl AcceptanceContractVersionSummary {
    pub(crate) fn snapshot(&self) -> AcceptanceContractSnapshot {
        AcceptanceContractSnapshot {
            schema_version: self.schema,
            name: self.name.clone(),
            gates: self.gates.clone(),
        }
    }

    pub(crate) fn draft(&self) -> AcceptanceContractDraft {
        AcceptanceContractDraft {
            name: self.name.clone(),
            gates: self.gates.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AcceptanceContractVersionRecord {
    pub workspace_id: i64,
    pub summary: AcceptanceContractVersionSummary,
}

#[derive(Debug, Clone)]
pub struct SaveTaskAcceptanceContractRequest {
    pub project_path: String,
    pub task_id: String,
    pub expected_current_version_id: Option<String>,
    pub contract: Option<AcceptanceContractDraft>,
}

impl<'de> Deserialize<'de> for SaveTaskAcceptanceContractRequest {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Request {
            project_path: String,
            task_id: String,
            expected_current_version_id: Value,
            contract: Option<AcceptanceContractDraft>,
        }

        let request = Request::deserialize(deserializer)?;
        let expected_current_version_id = match request.expected_current_version_id {
            Value::Null => None,
            Value::String(version_id) => Some(version_id),
            _ => {
                return Err(serde::de::Error::custom(
                    "expectedCurrentVersionId must be a string or null",
                ))
            }
        };
        Ok(Self {
            project_path: request.project_path,
            task_id: request.task_id,
            expected_current_version_id,
            contract: request.contract,
        })
    }
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PackageManager {
    Npm,
    Pnpm,
    Yarn,
    Bun,
}

impl PackageManager {
    pub(crate) fn executable_name(self) -> &'static str {
        match self {
            Self::Npm => "npm",
            Self::Pnpm => "pnpm",
            Self::Yarn => "yarn",
            Self::Bun => "bun",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcceptanceContractPreset {
    pub script_name: String,
    pub package_manager: PackageManager,
    pub draft: AcceptanceContractDraft,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AcceptancePresetDiscoveryErrorCode {
    ExecutionContext,
    ManifestRead,
    ManifestTooLarge,
    MalformedManifest,
    UnsupportedPackageManager,
    PackageManagerUnavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcceptancePresetDiscoveryError {
    pub code: AcceptancePresetDiscoveryErrorCode,
    pub message: String,
}

impl AcceptancePresetDiscoveryError {
    pub(crate) fn new(
        code: AcceptancePresetDiscoveryErrorCode,
        message: impl Into<String>,
    ) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum VerificationBaselineState {
    #[default]
    NotRequired,
    Pending,
    Ready,
    Unavailable,
}

impl VerificationBaselineState {
    pub(crate) fn as_database(self) -> &'static str {
        match self {
            Self::NotRequired => "not_required",
            Self::Pending => "pending",
            Self::Ready => "ready",
            Self::Unavailable => "unavailable",
        }
    }

    pub(crate) fn from_database(value: &str) -> Result<Self, String> {
        match value {
            "not_required" => Ok(Self::NotRequired),
            "pending" => Ok(Self::Pending),
            "ready" => Ok(Self::Ready),
            "unavailable" => Ok(Self::Unavailable),
            _ => Err(format!(
                "Unsupported verification baseline state `{value}`."
            )),
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum VerificationAttemptTrigger {
    Initial,
    Rerun,
}

impl VerificationAttemptTrigger {
    pub(crate) fn as_database(self) -> &'static str {
        match self {
            Self::Initial => "initial",
            Self::Rerun => "rerun",
        }
    }

    pub(crate) fn from_database(value: &str) -> Result<Self, String> {
        match value {
            "initial" => Ok(Self::Initial),
            "rerun" => Ok(Self::Rerun),
            _ => Err(format!("Unsupported verification trigger `{value}`.")),
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum VerificationAttemptStatus {
    Running,
    Passed,
    Failed,
    Blocked,
    Cancelled,
    Interrupted,
}

impl VerificationAttemptStatus {
    pub(crate) fn as_database(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Passed => "passed",
            Self::Failed => "failed",
            Self::Blocked => "blocked",
            Self::Cancelled => "cancelled",
            Self::Interrupted => "interrupted",
        }
    }

    pub(crate) fn from_database(value: &str) -> Result<Self, String> {
        match value {
            "running" => Ok(Self::Running),
            "passed" => Ok(Self::Passed),
            "failed" => Ok(Self::Failed),
            "blocked" => Ok(Self::Blocked),
            "cancelled" => Ok(Self::Cancelled),
            "interrupted" => Ok(Self::Interrupted),
            _ => Err(format!(
                "Unsupported verification attempt status `{value}`."
            )),
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum VerificationGateType {
    Command,
    DiffScope,
    Cleanliness,
}

impl VerificationGateType {
    pub(crate) fn as_database(self) -> &'static str {
        match self {
            Self::Command => "command",
            Self::DiffScope => "diff_scope",
            Self::Cleanliness => "cleanliness",
        }
    }

    pub(crate) fn from_database(value: &str) -> Result<Self, String> {
        match value {
            "command" => Ok(Self::Command),
            "diff_scope" => Ok(Self::DiffScope),
            "cleanliness" => Ok(Self::Cleanliness),
            _ => Err(format!("Unsupported verification gate type `{value}`.")),
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum VerificationGateOutcome {
    Passed,
    Failed,
    Blocked,
    Cancelled,
}

impl VerificationGateOutcome {
    pub(crate) fn as_database(self) -> &'static str {
        match self {
            Self::Passed => "passed",
            Self::Failed => "failed",
            Self::Blocked => "blocked",
            Self::Cancelled => "cancelled",
        }
    }

    pub(crate) fn from_database(value: &str) -> Result<Self, String> {
        match value {
            "passed" => Ok(Self::Passed),
            "failed" => Ok(Self::Failed),
            "blocked" => Ok(Self::Blocked),
            "cancelled" => Ok(Self::Cancelled),
            _ => Err(format!("Unsupported verification gate outcome `{value}`.")),
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ArtifactRetentionClass {
    RunEvidence,
    VerificationBaseline,
}

impl ArtifactRetentionClass {
    pub(crate) fn as_database(self) -> &'static str {
        match self {
            Self::RunEvidence => "run_evidence",
            Self::VerificationBaseline => "verification_baseline",
        }
    }

    pub(crate) fn from_database(value: &str) -> Result<Self, String> {
        match value {
            "run_evidence" => Ok(Self::RunEvidence),
            "verification_baseline" => Ok(Self::VerificationBaseline),
            _ => Err(format!("Unsupported artifact retention class `{value}`.")),
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EvidenceRedactionState {
    Safe,
    BestEffort,
}

impl EvidenceRedactionState {
    pub(crate) fn as_database(self) -> &'static str {
        match self {
            Self::Safe => "safe",
            Self::BestEffort => "best_effort",
        }
    }

    pub(crate) fn from_database(value: &str) -> Result<Self, String> {
        match value {
            "safe" => Ok(Self::Safe),
            "best_effort" => Ok(Self::BestEffort),
            _ => Err(format!("Unsupported evidence redaction state `{value}`.")),
        }
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationAttemptRecord {
    pub id: String,
    pub run_id: String,
    pub request_key: String,
    pub attempt_number: u32,
    pub trigger: VerificationAttemptTrigger,
    pub contract_snapshot: AcceptanceContractSnapshot,
    pub contract_snapshot_sha256: String,
    pub expected_gate_count: usize,
    pub status: VerificationAttemptStatus,
    pub diagnostic: Option<String>,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub updated_at: i64,
    pub version: i64,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GateResultRecord {
    pub id: String,
    pub verification_attempt_id: String,
    pub gate_index: usize,
    pub gate_type: VerificationGateType,
    pub outcome: VerificationGateOutcome,
    pub duration_ms: u64,
    pub exit_code: Option<i32>,
    pub diagnostic: Option<String>,
    pub started_at: i64,
    pub finished_at: i64,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactRecord {
    pub id: String,
    pub run_id: String,
    pub verification_attempt_id: Option<String>,
    pub relative_storage_path: String,
    pub media_type: String,
    pub byte_length: u64,
    pub sha256: String,
    pub retention_class: ArtifactRetentionClass,
    pub created_at: i64,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceRecord {
    pub id: String,
    pub run_id: String,
    pub verification_attempt_id: Option<String>,
    pub gate_result_id: Option<String>,
    pub evidence_type: String,
    pub summary: Value,
    pub artifact_id: Option<String>,
    pub redaction_state: EvidenceRedactionState,
    pub created_at: i64,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationArtifactSummary {
    pub id: String,
    pub media_type: String,
    pub byte_length: u64,
    pub sha256: String,
    pub retention_class: ArtifactRetentionClass,
    pub created_at: i64,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationEvidenceItem {
    pub evidence: EvidenceRecord,
    pub artifact: Option<VerificationArtifactSummary>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationGateEvidence {
    pub result: GateResultRecord,
    pub evidence: Vec<VerificationEvidenceItem>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationAttemptEvidence {
    pub attempt: VerificationAttemptRecord,
    pub gates: Vec<VerificationGateEvidence>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationEvidencePage {
    pub attempts: Vec<VerificationAttemptEvidence>,
    pub has_more: bool,
}

fn normalize_contract(
    name: &str,
    gates: &[AcceptanceGate],
) -> Result<NormalizedAcceptanceContract, String> {
    let name = name.trim().to_owned();
    if name.is_empty() {
        return Err("An acceptance contract name is required.".to_owned());
    }
    if gates.is_empty() {
        return Err("An acceptance contract requires at least one gate.".to_owned());
    }
    if gates.len() > MAX_ACCEPTANCE_CONTRACT_GATES {
        return Err(format!(
            "An acceptance contract cannot contain more than {MAX_ACCEPTANCE_CONTRACT_GATES} gates."
        ));
    }

    let gates = gates
        .iter()
        .map(normalize_gate)
        .collect::<Result<Vec<_>, _>>()?;
    let snapshot = AcceptanceContractSnapshot {
        schema_version: ACCEPTANCE_CONTRACT_SCHEMA_VERSION,
        name,
        gates,
    };
    let canonical_json = serde_json::to_string(&snapshot)
        .map_err(|error| format!("Could not serialize the acceptance contract: {error}"))?;
    if canonical_json.len() > MAX_ACCEPTANCE_CONTRACT_JSON_BYTES {
        return Err(format!(
            "The acceptance contract exceeds the {} KiB limit.",
            MAX_ACCEPTANCE_CONTRACT_JSON_BYTES / 1024
        ));
    }
    let content_sha256 = sha256_hex(canonical_json.as_bytes());
    Ok(NormalizedAcceptanceContract {
        snapshot,
        canonical_json,
        content_sha256,
    })
}

fn normalize_gate(gate: &AcceptanceGate) -> Result<AcceptanceGate, String> {
    match gate {
        AcceptanceGate::Command {
            executable,
            argv,
            timeout_ms,
            expected_exit_codes,
        } => {
            let executable = executable.trim().to_owned();
            if executable.is_empty() {
                return Err("A command gate executable is required.".to_owned());
            }
            if argv.len() > MAX_COMMAND_ARGUMENTS {
                return Err(format!(
                    "A command gate cannot contain more than {MAX_COMMAND_ARGUMENTS} arguments."
                ));
            }
            let argv_bytes = argv.iter().try_fold(0usize, |total, argument| {
                total
                    .checked_add(argument.len())
                    .ok_or("The command gate argv is too large.".to_owned())
            })?;
            if argv_bytes > MAX_COMMAND_ARGV_BYTES {
                return Err(format!(
                    "A command gate argv exceeds the {} KiB limit.",
                    MAX_COMMAND_ARGV_BYTES / 1024
                ));
            }
            if !(MIN_COMMAND_TIMEOUT_MS..=MAX_COMMAND_TIMEOUT_MS).contains(timeout_ms) {
                return Err(
                    "A command gate timeout must be between 1 second and 1 hour.".to_owned(),
                );
            }
            if expected_exit_codes.is_empty() || expected_exit_codes.len() > MAX_EXPECTED_EXIT_CODES
            {
                return Err(format!(
                    "A command gate requires between 1 and {MAX_EXPECTED_EXIT_CODES} expected exit codes."
                ));
            }
            let mut expected_exit_codes = expected_exit_codes.clone();
            expected_exit_codes.sort_unstable();
            expected_exit_codes.dedup();
            Ok(AcceptanceGate::Command {
                executable,
                argv: argv.clone(),
                timeout_ms: *timeout_ms,
                expected_exit_codes,
            })
        }
        AcceptanceGate::DiffScope {
            allowed_patterns,
            denied_patterns,
        } => {
            let allowed_patterns = normalize_patterns(allowed_patterns, "allowed")?;
            let denied_patterns = normalize_patterns(denied_patterns, "denied")?;
            if allowed_patterns.is_empty() && denied_patterns.is_empty() {
                return Err("A diff-scope gate requires at least one path pattern.".to_owned());
            }
            Ok(AcceptanceGate::DiffScope {
                allowed_patterns,
                denied_patterns,
            })
        }
        AcceptanceGate::Cleanliness {
            allow_staged,
            allow_unstaged,
            allow_untracked,
        } => Ok(AcceptanceGate::Cleanliness {
            allow_staged: *allow_staged,
            allow_unstaged: *allow_unstaged,
            allow_untracked: *allow_untracked,
        }),
    }
}

fn normalize_patterns(patterns: &[String], label: &str) -> Result<Vec<String>, String> {
    if patterns.len() > MAX_PATH_PATTERNS {
        return Err(format!(
            "A diff-scope gate cannot contain more than {MAX_PATH_PATTERNS} {label} patterns."
        ));
    }
    patterns
        .iter()
        .map(|pattern| {
            let pattern = pattern.trim().to_owned();
            validate_path_pattern(&pattern)?;
            Ok(pattern)
        })
        .collect()
}

fn validate_path_pattern(pattern: &str) -> Result<(), String> {
    if pattern.is_empty() {
        return Err("Diff-scope path patterns cannot be empty.".to_owned());
    }
    if pattern.len() > MAX_PATH_PATTERN_BYTES {
        return Err(format!(
            "Diff-scope path patterns cannot exceed {MAX_PATH_PATTERN_BYTES} bytes."
        ));
    }
    if pattern.contains('\\') {
        return Err("Diff-scope path patterns must use `/` separators.".to_owned());
    }
    let bytes = pattern.as_bytes();
    if pattern.starts_with('/')
        || (bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':')
    {
        return Err("Diff-scope path patterns must be relative.".to_owned());
    }
    if pattern.split('/').any(|segment| segment == "..") {
        return Err("Diff-scope path patterns cannot contain `..` segments.".to_owned());
    }
    Ok(())
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut encoded = String::with_capacity(digest.len() * 2);
    for byte in digest {
        let _ = write!(encoded, "{byte:02x}");
    }
    encoded
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn command_gate() -> AcceptanceGate {
        AcceptanceGate::Command {
            executable: " cargo ".to_owned(),
            argv: vec!["test".to_owned(), "--".to_owned(), "a b".to_owned()],
            timeout_ms: 60_000,
            expected_exit_codes: vec![1, 0, 1],
        }
    }

    #[test]
    fn normalization_is_canonical_and_hashes_identical_drafts_equally() {
        let first = AcceptanceContractDraft {
            name: "  Verify workspace  ".to_owned(),
            gates: vec![
                command_gate(),
                AcceptanceGate::DiffScope {
                    allowed_patterns: vec![" src/** ".to_owned()],
                    denied_patterns: vec![" secrets/** ".to_owned()],
                },
            ],
        }
        .normalize()
        .unwrap();
        let second = AcceptanceContractDraft {
            name: "Verify workspace".to_owned(),
            gates: vec![
                AcceptanceGate::Command {
                    executable: "cargo".to_owned(),
                    argv: vec!["test".to_owned(), "--".to_owned(), "a b".to_owned()],
                    timeout_ms: 60_000,
                    expected_exit_codes: vec![0, 1],
                },
                AcceptanceGate::DiffScope {
                    allowed_patterns: vec!["src/**".to_owned()],
                    denied_patterns: vec!["secrets/**".to_owned()],
                },
            ],
        }
        .normalize()
        .unwrap();

        assert_eq!(first.snapshot, second.snapshot);
        assert_eq!(first.canonical_json, second.canonical_json);
        assert_eq!(first.content_sha256, second.content_sha256);
        let mut reversed_gates = second.snapshot.gates.clone();
        reversed_gates.reverse();
        let reversed = AcceptanceContractDraft {
            name: second.snapshot.name.clone(),
            gates: reversed_gates,
        }
        .normalize()
        .unwrap();
        assert_ne!(second.content_sha256, reversed.content_sha256);
        let AcceptanceGate::Command {
            executable,
            argv,
            expected_exit_codes,
            ..
        } = &first.snapshot.gates[0]
        else {
            panic!("expected command gate")
        };
        assert_eq!(executable, "cargo");
        assert_eq!(argv, &["test", "--", "a b"]);
        assert_eq!(expected_exit_codes, &[0, 1]);
    }

    #[test]
    fn validation_rejects_empty_oversized_and_unsafe_contracts() {
        assert!(AcceptanceContractDraft {
            name: " ".to_owned(),
            gates: vec![command_gate()],
        }
        .normalize()
        .is_err());
        assert!(AcceptanceContractDraft {
            name: "Empty".to_owned(),
            gates: Vec::new(),
        }
        .normalize()
        .is_err());
        assert!(AcceptanceContractDraft {
            name: "Too many".to_owned(),
            gates: vec![
                AcceptanceGate::Cleanliness {
                    allow_staged: false,
                    allow_unstaged: false,
                    allow_untracked: false,
                };
                MAX_ACCEPTANCE_CONTRACT_GATES + 1
            ],
        }
        .normalize()
        .is_err());

        for pattern in [
            "",
            "/absolute/**",
            "C:/absolute/**",
            "src\\**",
            "src/../secret",
        ] {
            assert!(
                AcceptanceContractDraft {
                    name: "Unsafe pattern".to_owned(),
                    gates: vec![AcceptanceGate::DiffScope {
                        allowed_patterns: vec![pattern.to_owned()],
                        denied_patterns: Vec::new(),
                    }],
                }
                .normalize()
                .is_err(),
                "pattern `{pattern}` should be rejected"
            );
        }

        let mut too_many_arguments = command_gate();
        let AcceptanceGate::Command { argv, .. } = &mut too_many_arguments else {
            unreachable!()
        };
        *argv = vec!["arg".to_owned(); MAX_COMMAND_ARGUMENTS + 1];
        assert!(AcceptanceContractDraft {
            name: "Too many args".to_owned(),
            gates: vec![too_many_arguments],
        }
        .normalize()
        .is_err());

        let oversized_argv = AcceptanceGate::Command {
            executable: "tool".to_owned(),
            argv: vec!["x".repeat(MAX_COMMAND_ARGV_BYTES + 1)],
            timeout_ms: MIN_COMMAND_TIMEOUT_MS,
            expected_exit_codes: vec![0],
        };
        assert!(AcceptanceContractDraft {
            name: "Large argv".to_owned(),
            gates: vec![oversized_argv],
        }
        .normalize()
        .is_err());

        for timeout_ms in [MIN_COMMAND_TIMEOUT_MS - 1, MAX_COMMAND_TIMEOUT_MS + 1] {
            assert!(AcceptanceContractDraft {
                name: "Invalid timeout".to_owned(),
                gates: vec![AcceptanceGate::Command {
                    executable: "tool".to_owned(),
                    argv: Vec::new(),
                    timeout_ms,
                    expected_exit_codes: vec![0],
                }],
            }
            .normalize()
            .is_err());
        }
        for expected_exit_codes in [Vec::new(), vec![0; MAX_EXPECTED_EXIT_CODES + 1]] {
            assert!(AcceptanceContractDraft {
                name: "Invalid exit codes".to_owned(),
                gates: vec![AcceptanceGate::Command {
                    executable: "tool".to_owned(),
                    argv: Vec::new(),
                    timeout_ms: MIN_COMMAND_TIMEOUT_MS,
                    expected_exit_codes,
                }],
            }
            .normalize()
            .is_err());
        }
        assert!(AcceptanceContractDraft {
            name: "Too many patterns".to_owned(),
            gates: vec![AcceptanceGate::DiffScope {
                allowed_patterns: vec!["src/**".to_owned(); MAX_PATH_PATTERNS + 1],
                denied_patterns: Vec::new(),
            }],
        }
        .normalize()
        .is_err());
    }

    #[test]
    fn save_request_requires_an_explicit_nullable_expected_version() {
        let missing = serde_json::from_value::<SaveTaskAcceptanceContractRequest>(json!({
            "projectPath": "workspace",
            "taskId": "task",
            "contract": null,
        }));
        assert!(missing.is_err());

        let null = serde_json::from_value::<SaveTaskAcceptanceContractRequest>(json!({
            "projectPath": "workspace",
            "taskId": "task",
            "expectedCurrentVersionId": null,
            "contract": null,
        }))
        .unwrap();
        assert_eq!(null.expected_current_version_id, None);

        let observed = serde_json::from_value::<SaveTaskAcceptanceContractRequest>(json!({
            "projectPath": "workspace",
            "taskId": "task",
            "expectedCurrentVersionId": "version-1",
            "contract": null,
        }))
        .unwrap();
        assert_eq!(
            observed.expected_current_version_id.as_deref(),
            Some("version-1")
        );
    }

    #[test]
    fn serde_is_camel_case_while_database_values_are_snake_case() {
        let gate = AcceptanceGate::DiffScope {
            allowed_patterns: vec!["src/**".to_owned()],
            denied_patterns: vec!["target/**".to_owned()],
        };
        let value = serde_json::to_value(&gate).unwrap();
        assert_eq!(value["type"], "diffScope");
        assert_eq!(value["allowedPatterns"][0], "src/**");
        assert_eq!(value["deniedPatterns"][0], "target/**");
        assert_eq!(
            serde_json::to_value(VerificationBaselineState::NotRequired).unwrap(),
            "notRequired"
        );
        assert_eq!(
            VerificationBaselineState::NotRequired.as_database(),
            "not_required"
        );
        assert_eq!(VerificationGateType::DiffScope.as_database(), "diff_scope");
        assert_eq!(
            VerificationGateType::from_database("diff_scope").unwrap(),
            VerificationGateType::DiffScope
        );
    }
}
