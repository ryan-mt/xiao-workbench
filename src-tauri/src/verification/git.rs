use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::process::{supervise_process_tree, supervise_process_tree_with_input};

use super::executor::resolve_command_executable;
use super::models::VerificationGateOutcome;

const GIT_STATE_SCHEMA_VERSION: u32 = 1;
const GIT_COMMAND_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_GIT_STDOUT_BYTES: usize = 64 * 1024 * 1024;
const MAX_GIT_STDERR_BYTES: usize = 64 * 1024;
const GIT_READ_CHUNK_BYTES: usize = 16 * 1024;
const GIT_OUTPUT_CHANNEL_CAPACITY: usize = 32;
const GIT_POLL_INTERVAL: Duration = Duration::from_millis(10);
const GIT_SELECTION_ENVIRONMENT_OVERRIDES: [&str; 15] = [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_IMPLICIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_GRAFT_FILE",
    "GIT_NAMESPACE",
    "GIT_SHALLOW_FILE",
    "GIT_REPLACE_REF_BASE",
    "GIT_PREFIX",
    "GIT_INTERNAL_SUPER_PREFIX",
    "GIT_CEILING_DIRECTORIES",
    "GIT_DISCOVERY_ACROSS_FILESYSTEM",
];
const GIT_CONFIG_ENVIRONMENT_OVERRIDES: [&str; 6] = [
    "GIT_CONFIG",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_SYSTEM",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_NOSYSTEM",
];
const EMPTY_GIT_CONFIG_PATH: &str = "/dev/null";

#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitStateSnapshot {
    pub schema_version: u32,
    pub repository_identity_sha256: String,
    pub head_commit: Option<String>,
    pub index_sha256: Option<String>,
    pub entries: Vec<GitStatusEntry>,
}

impl GitStateSnapshot {
    pub(crate) fn validate(&self) -> Result<(), String> {
        if self.schema_version != GIT_STATE_SCHEMA_VERSION {
            return Err(format!(
                "Unsupported Git baseline schema version {}.",
                self.schema_version
            ));
        }
        if !is_sha256(&self.repository_identity_sha256) {
            return Err("The Git baseline repository identity is invalid.".to_owned());
        }
        if self
            .index_sha256
            .as_deref()
            .is_some_and(|value| !is_sha256(value))
        {
            return Err("The Git baseline index checksum is invalid.".to_owned());
        }
        if self
            .head_commit
            .as_deref()
            .is_some_and(|value| !is_object_id(value))
        {
            return Err("The Git baseline HEAD object ID is invalid.".to_owned());
        }
        let mut previous = None;
        for entry in &self.entries {
            entry.validate()?;
            let key = (&entry.path, &entry.original_path);
            if previous.as_ref().is_some_and(|previous| previous >= &key) {
                return Err("Git baseline entries are not canonical.".to_owned());
            }
            previous = Some(key);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum GitStatusKind {
    Ordinary,
    RenameOrCopy,
    Unmerged,
    Untracked,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitStatusEntry {
    pub kind: GitStatusKind,
    pub path: String,
    pub original_path: Option<String>,
    pub index_status: Option<char>,
    pub worktree_status: Option<char>,
    pub metadata: Vec<String>,
    pub worktree: GitWorktreeFingerprint,
}

impl GitStatusEntry {
    fn validate(&self) -> Result<(), String> {
        validate_git_path(&self.path)?;
        if let Some(path) = &self.original_path {
            validate_git_path(path)?;
        }
        if self.kind == GitStatusKind::RenameOrCopy && self.original_path.is_none() {
            return Err("A Git rename/copy baseline entry is missing its source path.".to_owned());
        }
        if self.kind != GitStatusKind::RenameOrCopy && self.original_path.is_some() {
            return Err(
                "Only Git rename/copy baseline entries may contain a source path.".to_owned(),
            );
        }
        if self.kind == GitStatusKind::Untracked {
            if self.index_status.is_some() || self.worktree_status.is_some() {
                return Err("An untracked Git baseline entry has invalid status fields.".to_owned());
            }
        } else if self.index_status.is_none() || self.worktree_status.is_none() {
            return Err("A tracked Git baseline entry is missing status fields.".to_owned());
        }
        self.worktree.validate()
    }

    fn is_staged(&self) -> bool {
        self.kind == GitStatusKind::Unmerged
            || self
                .index_status
                .is_some_and(|status| status != '.' && status != ' ')
    }

    fn is_unstaged(&self) -> bool {
        self.kind == GitStatusKind::Unmerged
            || self
                .worktree_status
                .is_some_and(|status| status != '.' && status != ' ')
    }

    fn paths(&self) -> impl Iterator<Item = &str> {
        std::iter::once(self.path.as_str()).chain(self.original_path.as_deref())
    }
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum GitWorktreePathKind {
    Missing,
    File,
    Directory,
    Symlink,
    Other,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitWorktreeFingerprint {
    pub kind: GitWorktreePathKind,
    pub byte_length: Option<u64>,
    pub sha256: Option<String>,
}

impl GitWorktreeFingerprint {
    fn validate(&self) -> Result<(), String> {
        match self.kind {
            GitWorktreePathKind::File | GitWorktreePathKind::Symlink => {
                if self.byte_length.is_none()
                    || self.sha256.as_deref().is_none_or(|value| !is_sha256(value))
                {
                    return Err("A Git baseline file fingerprint is invalid.".to_owned());
                }
            }
            GitWorktreePathKind::Missing
            | GitWorktreePathKind::Directory
            | GitWorktreePathKind::Other => {
                if self.byte_length.is_some() || self.sha256.is_some() {
                    return Err("A Git baseline non-file fingerprint is invalid.".to_owned());
                }
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct GitReadError {
    pub outcome: VerificationGateOutcome,
    pub diagnostic: String,
}

impl GitReadError {
    fn blocked(diagnostic: impl Into<String>) -> Self {
        Self {
            outcome: VerificationGateOutcome::Blocked,
            diagnostic: diagnostic.into(),
        }
    }

    fn cancelled(diagnostic: impl Into<String>) -> Self {
        Self {
            outcome: VerificationGateOutcome::Cancelled,
            diagnostic: diagnostic.into(),
        }
    }
}

pub(crate) fn capture_git_state(
    execution_root: &Path,
    cancellation: &AtomicBool,
) -> Result<GitStateSnapshot, GitReadError> {
    capture_git_state_with_supervision(execution_root, cancellation, !cfg!(test))
}

fn capture_git_state_with_supervision(
    execution_root: &Path,
    cancellation: &AtomicBool,
    supervise: bool,
) -> Result<GitStateSnapshot, GitReadError> {
    if cancellation.load(Ordering::Acquire) {
        return Err(GitReadError::cancelled(
            "Verification was cancelled before Git state capture started.",
        ));
    }
    let execution_root = fs::canonicalize(execution_root).map_err(|error| {
        GitReadError::blocked(format!(
            "Could not resolve the stored run execution root: {error}"
        ))
    })?;
    if !execution_root.is_dir() {
        return Err(GitReadError::blocked(
            "The stored run execution root is not a directory.",
        ));
    }
    let git = resolve_command_executable(&execution_root, "git")
        .map_err(|error| GitReadError::blocked(format!("Git is unavailable: {error}")))?;

    let root_output = run_git_checked(
        &git,
        &execution_root,
        &["rev-parse", "--path-format=absolute", "--show-toplevel"],
        cancellation,
        supervise,
    )?;
    let root_text = decode_trimmed_git_text(&root_output, "repository root")?;
    let repository_root = fs::canonicalize(root_text).map_err(|error| {
        GitReadError::blocked(format!(
            "Could not resolve the Git repository root: {error}"
        ))
    })?;
    if execution_root != repository_root {
        return Err(GitReadError::blocked(
            "Git-backed verification requires the stored run execution root to be the repository top level.",
        ));
    }

    let head_output = run_git(
        &git,
        &execution_root,
        &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
        cancellation,
        supervise,
    )?;
    let head_commit = match head_output.exit_code {
        Some(0) => {
            let value = decode_trimmed_git_text(&head_output.stdout, "HEAD object ID")?;
            if !is_object_id(value) {
                return Err(GitReadError::blocked(
                    "Git returned an invalid HEAD object ID.",
                ));
            }
            Some(value.to_owned())
        }
        Some(1) if head_output.stderr.is_empty() => None,
        _ => return Err(git_exit_error("read HEAD", &head_output)),
    };

    let tracked_paths = reject_hidden_index_paths(&git, &execution_root, cancellation, supervise)?;
    reject_active_filter_attributes(
        &git,
        &execution_root,
        &tracked_paths,
        cancellation,
        supervise,
    )?;
    reject_gitlinks(
        &git,
        &execution_root,
        head_commit.as_deref(),
        cancellation,
        supervise,
    )?;

    let status_output = run_git_checked(
        &git,
        &execution_root,
        &[
            "-c",
            "core.quotepath=false",
            "-c",
            "status.relativePaths=false",
            "-c",
            "core.fsmonitor=false",
            "status",
            "--porcelain=v2",
            "-z",
            "--untracked-files=all",
            "--ignore-submodules=none",
            "--renames",
        ],
        cancellation,
        supervise,
    )?;
    let mut entries = parse_porcelain_v2(&status_output, &repository_root, cancellation)?;
    entries.sort_by(|left, right| {
        (&left.path, &left.original_path).cmp(&(&right.path, &right.original_path))
    });

    let index_output = run_git_checked(
        &git,
        &execution_root,
        &["rev-parse", "--git-path", "index"],
        cancellation,
        supervise,
    )?;
    let index_text = decode_trimmed_git_text(&index_output, "Git index path")?;
    let index_path = Path::new(index_text);
    let index_path = if index_path.is_absolute() {
        index_path.to_path_buf()
    } else {
        execution_root.join(index_path)
    };
    let index_sha256 = if index_path.is_file() {
        Some(hash_file(&index_path, cancellation)?.1)
    } else {
        None
    };

    let snapshot = GitStateSnapshot {
        schema_version: GIT_STATE_SCHEMA_VERSION,
        repository_identity_sha256: repository_identity(&repository_root),
        head_commit,
        index_sha256,
        entries,
    };
    snapshot.validate().map_err(GitReadError::blocked)?;
    Ok(snapshot)
}

fn reject_hidden_index_paths(
    git: &Path,
    execution_root: &Path,
    cancellation: &AtomicBool,
    supervise: bool,
) -> Result<Vec<u8>, GitReadError> {
    let output = run_git_checked(
        git,
        execution_root,
        &["ls-files", "-v", "-z"],
        cancellation,
        supervise,
    )?;
    let mut paths = Vec::with_capacity(output.len());
    for record in output
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
    {
        if record.len() < 3 || record[1] != b' ' {
            return Err(GitReadError::blocked(
                "Git returned malformed tracked-path visibility data.",
            ));
        }
        if record[0] == b'S' || record[0].is_ascii_lowercase() {
            return Err(GitReadError::blocked(
                "Git-backed verification requires assume-unchanged and skip-worktree flags to be cleared.",
            ));
        }
        let path = std::str::from_utf8(&record[2..])
            .map_err(|_| GitReadError::blocked("Git returned a path that is not valid UTF-8."))?;
        let worktree_path =
            repository_path_from_git(execution_root, path).map_err(GitReadError::blocked)?;
        reject_linked_worktree_ancestors(execution_root, &worktree_path)?;
        paths.extend_from_slice(&record[2..]);
        paths.push(0);
    }
    Ok(paths)
}

fn reject_active_filter_attributes(
    git: &Path,
    execution_root: &Path,
    tracked_paths: &[u8],
    cancellation: &AtomicBool,
    supervise: bool,
) -> Result<(), GitReadError> {
    if tracked_paths.is_empty() {
        return Ok(());
    }
    let output = run_git_checked_with_input(
        git,
        execution_root,
        &["check-attr", "-z", "--stdin", "filter"],
        tracked_paths,
        cancellation,
        supervise,
    )?;
    validate_filter_attribute_output(tracked_paths, &output)
}

fn validate_filter_attribute_output(
    tracked_paths: &[u8],
    output: &[u8],
) -> Result<(), GitReadError> {
    let mut fields = output.split(|byte| *byte == 0);
    for expected_path in tracked_paths
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
    {
        let path = fields.next().ok_or_else(|| {
            GitReadError::blocked("Git returned incomplete filter attribute data.")
        })?;
        let attribute = fields.next().ok_or_else(|| {
            GitReadError::blocked("Git returned malformed filter attribute data.")
        })?;
        let value = fields.next().ok_or_else(|| {
            GitReadError::blocked("Git returned malformed filter attribute data.")
        })?;
        if path != expected_path {
            return Err(GitReadError::blocked(
                "Git filter attribute data did not cover every tracked path.",
            ));
        }
        if attribute != b"filter" {
            return Err(GitReadError::blocked(
                "Git returned unexpected filter attribute data.",
            ));
        }
        if value != b"unspecified" && value != b"unset" {
            return Err(GitReadError::blocked(
                "Git-backed verification does not execute tracked-file filter drivers.",
            ));
        }
    }
    if fields.next() != Some(&[][..]) || fields.next().is_some() {
        return Err(GitReadError::blocked(
            "Git returned unexpected filter attribute data.",
        ));
    }
    Ok(())
}

fn reject_gitlinks(
    git: &Path,
    execution_root: &Path,
    head_commit: Option<&str>,
    cancellation: &AtomicBool,
    supervise: bool,
) -> Result<(), GitReadError> {
    let index_output = run_git_checked(
        git,
        execution_root,
        &["ls-files", "--stage", "-z"],
        cancellation,
        supervise,
    )?;
    if contains_gitlink(&index_output) {
        return Err(unsupported_gitlink_error());
    }

    if let Some(head_commit) = head_commit {
        let head_output = run_git_checked_owned(
            git,
            execution_root,
            vec![
                "ls-tree".to_owned(),
                "-r".to_owned(),
                "-z".to_owned(),
                "--full-tree".to_owned(),
                head_commit.to_owned(),
                "--".to_owned(),
            ],
            cancellation,
            supervise,
        )?;
        if contains_gitlink(&head_output) {
            return Err(unsupported_gitlink_error());
        }
    }
    Ok(())
}

fn contains_gitlink(output: &[u8]) -> bool {
    output
        .split(|byte| *byte == 0)
        .any(|record| record.starts_with(b"160000 "))
}

fn unsupported_gitlink_error() -> GitReadError {
    GitReadError::blocked(
        "Git-backed verification does not support repositories with submodule entries.",
    )
}

pub(crate) fn status_delta_paths(
    baseline: &GitStateSnapshot,
    final_state: &GitStateSnapshot,
) -> Result<Vec<String>, String> {
    baseline.validate()?;
    final_state.validate()?;
    if baseline.repository_identity_sha256 != final_state.repository_identity_sha256 {
        return Err("The final Git state belongs to a different repository.".to_owned());
    }

    let baseline_entries = entries_by_path(baseline);
    let final_entries = entries_by_path(final_state);
    let mut paths = BTreeSet::new();
    paths.extend(baseline_entries.keys().copied());
    paths.extend(final_entries.keys().copied());
    Ok(paths
        .into_iter()
        .filter(|path| baseline_entries.get(path) != final_entries.get(path))
        .map(ToOwned::to_owned)
        .collect())
}

pub(crate) fn read_committed_delta_paths(
    execution_root: &Path,
    baseline_head: Option<&str>,
    final_head: Option<&str>,
    cancellation: &AtomicBool,
) -> Result<Vec<String>, GitReadError> {
    read_committed_delta_paths_with_supervision(
        execution_root,
        baseline_head,
        final_head,
        cancellation,
        !cfg!(test),
    )
}

fn read_committed_delta_paths_with_supervision(
    execution_root: &Path,
    baseline_head: Option<&str>,
    final_head: Option<&str>,
    cancellation: &AtomicBool,
    supervise: bool,
) -> Result<Vec<String>, GitReadError> {
    if baseline_head == final_head {
        return Ok(Vec::new());
    }
    let execution_root = fs::canonicalize(execution_root).map_err(|error| {
        GitReadError::blocked(format!(
            "Could not resolve the stored run execution root: {error}"
        ))
    })?;
    let git = resolve_command_executable(&execution_root, "git")
        .map_err(|error| GitReadError::blocked(format!("Git is unavailable: {error}")))?;

    let paths = match (baseline_head, final_head) {
        (Some(baseline), Some(final_head)) => {
            if !is_object_id(baseline) || !is_object_id(final_head) {
                return Err(GitReadError::blocked(
                    "The verification baseline contains an invalid Git object ID.",
                ));
            }
            let output = run_git_checked_owned(
                &git,
                &execution_root,
                vec![
                    "diff".to_owned(),
                    "--no-ext-diff".to_owned(),
                    "--no-textconv".to_owned(),
                    "--name-status".to_owned(),
                    "-z".to_owned(),
                    "--find-renames".to_owned(),
                    "--find-copies".to_owned(),
                    baseline.to_owned(),
                    final_head.to_owned(),
                    "--".to_owned(),
                ],
                cancellation,
                supervise,
            )?;
            parse_name_status(&output)?
        }
        (None, Some(final_head)) => {
            if !is_object_id(final_head) {
                return Err(GitReadError::blocked(
                    "The final Git state contains an invalid HEAD object ID.",
                ));
            }
            let output = run_git_checked_owned(
                &git,
                &execution_root,
                vec![
                    "ls-tree".to_owned(),
                    "-r".to_owned(),
                    "-z".to_owned(),
                    "--name-only".to_owned(),
                    final_head.to_owned(),
                ],
                cancellation,
                supervise,
            )?;
            parse_nul_paths(&output)?
        }
        (Some(baseline), None) => {
            if !is_object_id(baseline) {
                return Err(GitReadError::blocked(
                    "The verification baseline contains an invalid HEAD object ID.",
                ));
            }
            let output = run_git_checked_owned(
                &git,
                &execution_root,
                vec![
                    "ls-tree".to_owned(),
                    "-r".to_owned(),
                    "-z".to_owned(),
                    "--name-only".to_owned(),
                    baseline.to_owned(),
                ],
                cancellation,
                supervise,
            )?;
            parse_nul_paths(&output)?
        }
        (None, None) => BTreeSet::new(),
    };
    Ok(paths.into_iter().collect())
}

type GitStatusPaths = (Vec<String>, Vec<String>, Vec<String>);

pub(crate) fn full_status_paths(snapshot: &GitStateSnapshot) -> Result<GitStatusPaths, String> {
    snapshot.validate()?;
    let mut staged = BTreeSet::new();
    let mut unstaged = BTreeSet::new();
    let mut untracked = BTreeSet::new();
    for entry in &snapshot.entries {
        if entry.kind == GitStatusKind::Untracked {
            untracked.extend(entry.paths().map(ToOwned::to_owned));
            continue;
        }
        if entry.is_staged() {
            staged.extend(entry.paths().map(ToOwned::to_owned));
        }
        if entry.is_unstaged() {
            unstaged.extend(entry.paths().map(ToOwned::to_owned));
        }
    }
    Ok((
        staged.into_iter().collect(),
        unstaged.into_iter().collect(),
        untracked.into_iter().collect(),
    ))
}

fn entries_by_path(snapshot: &GitStateSnapshot) -> BTreeMap<&str, Vec<&GitStatusEntry>> {
    let mut entries = BTreeMap::<&str, Vec<&GitStatusEntry>>::new();
    for entry in &snapshot.entries {
        for path in entry.paths() {
            entries.entry(path).or_default().push(entry);
        }
    }
    entries
}

fn parse_porcelain_v2(
    output: &[u8],
    repository_root: &Path,
    cancellation: &AtomicBool,
) -> Result<Vec<GitStatusEntry>, GitReadError> {
    let mut records = NulRecords::new(output);
    let mut entries = Vec::new();
    while let Some(record) = records.next_record()? {
        if cancellation.load(Ordering::Acquire) {
            return Err(GitReadError::cancelled(
                "Verification was cancelled while Git status was decoded.",
            ));
        }
        if record.is_empty() {
            continue;
        }
        let record = std::str::from_utf8(record)
            .map_err(|_| GitReadError::blocked("Git returned a path that is not valid UTF-8."))?;
        let mut entry = match record.as_bytes()[0] {
            b'1' => parse_ordinary_status(record)?,
            b'2' => {
                let mut entry = parse_rename_status(record)?;
                let original = records.next_record()?.ok_or_else(|| {
                    GitReadError::blocked("Git omitted a rename/copy source path.")
                })?;
                let original = std::str::from_utf8(original).map_err(|_| {
                    GitReadError::blocked("Git returned a path that is not valid UTF-8.")
                })?;
                validate_git_path(original).map_err(GitReadError::blocked)?;
                entry.original_path = Some(original.to_owned());
                entry
            }
            b'u' => parse_unmerged_status(record)?,
            b'?' => parse_untracked_status(record)?,
            _ => {
                return Err(GitReadError::blocked(
                    "Git returned an unsupported porcelain-v2 record.",
                ));
            }
        };
        let worktree_path = repository_path_from_git(repository_root, &entry.path)
            .map_err(GitReadError::blocked)?;
        entry.worktree = fingerprint_worktree_path(repository_root, &worktree_path, cancellation)?;
        entries.push(entry);
    }
    Ok(entries)
}

fn parse_ordinary_status(record: &str) -> Result<GitStatusEntry, GitReadError> {
    let fields = record.splitn(9, ' ').collect::<Vec<_>>();
    if fields.len() != 9 || fields[0] != "1" {
        return Err(GitReadError::blocked(
            "Git returned a malformed ordinary status record.",
        ));
    }
    let (index_status, worktree_status) = parse_xy(fields[1])?;
    validate_git_path(fields[8]).map_err(GitReadError::blocked)?;
    Ok(GitStatusEntry {
        kind: GitStatusKind::Ordinary,
        path: fields[8].to_owned(),
        original_path: None,
        index_status: Some(index_status),
        worktree_status: Some(worktree_status),
        metadata: fields[2..8]
            .iter()
            .map(|value| (*value).to_owned())
            .collect(),
        worktree: missing_fingerprint(),
    })
}

fn parse_rename_status(record: &str) -> Result<GitStatusEntry, GitReadError> {
    let fields = record.splitn(10, ' ').collect::<Vec<_>>();
    if fields.len() != 10 || fields[0] != "2" {
        return Err(GitReadError::blocked(
            "Git returned a malformed rename/copy status record.",
        ));
    }
    let (index_status, worktree_status) = parse_xy(fields[1])?;
    if !fields[8].starts_with('R') && !fields[8].starts_with('C') {
        return Err(GitReadError::blocked(
            "Git returned an invalid rename/copy score.",
        ));
    }
    validate_git_path(fields[9]).map_err(GitReadError::blocked)?;
    Ok(GitStatusEntry {
        kind: GitStatusKind::RenameOrCopy,
        path: fields[9].to_owned(),
        original_path: None,
        index_status: Some(index_status),
        worktree_status: Some(worktree_status),
        metadata: fields[2..9]
            .iter()
            .map(|value| (*value).to_owned())
            .collect(),
        worktree: missing_fingerprint(),
    })
}

fn parse_unmerged_status(record: &str) -> Result<GitStatusEntry, GitReadError> {
    let fields = record.splitn(11, ' ').collect::<Vec<_>>();
    if fields.len() != 11 || fields[0] != "u" {
        return Err(GitReadError::blocked(
            "Git returned a malformed unmerged status record.",
        ));
    }
    let (index_status, worktree_status) = parse_xy(fields[1])?;
    validate_git_path(fields[10]).map_err(GitReadError::blocked)?;
    Ok(GitStatusEntry {
        kind: GitStatusKind::Unmerged,
        path: fields[10].to_owned(),
        original_path: None,
        index_status: Some(index_status),
        worktree_status: Some(worktree_status),
        metadata: fields[2..10]
            .iter()
            .map(|value| (*value).to_owned())
            .collect(),
        worktree: missing_fingerprint(),
    })
}

fn parse_untracked_status(record: &str) -> Result<GitStatusEntry, GitReadError> {
    let Some(path) = record.strip_prefix("? ") else {
        return Err(GitReadError::blocked(
            "Git returned a malformed untracked status record.",
        ));
    };
    validate_git_path(path).map_err(GitReadError::blocked)?;
    Ok(GitStatusEntry {
        kind: GitStatusKind::Untracked,
        path: path.to_owned(),
        original_path: None,
        index_status: None,
        worktree_status: None,
        metadata: Vec::new(),
        worktree: missing_fingerprint(),
    })
}

fn parse_xy(value: &str) -> Result<(char, char), GitReadError> {
    let mut characters = value.chars();
    let Some(index) = characters.next() else {
        return Err(GitReadError::blocked("Git returned an invalid XY status."));
    };
    let Some(worktree) = characters.next() else {
        return Err(GitReadError::blocked("Git returned an invalid XY status."));
    };
    if characters.next().is_some()
        || !matches!(index, '.' | 'M' | 'T' | 'A' | 'D' | 'R' | 'C' | 'U')
        || !matches!(worktree, '.' | 'M' | 'T' | 'A' | 'D' | 'R' | 'C' | 'U')
    {
        return Err(GitReadError::blocked("Git returned an invalid XY status."));
    }
    Ok((index, worktree))
}

fn parse_name_status(output: &[u8]) -> Result<BTreeSet<String>, GitReadError> {
    let records = parse_utf8_nul_records(output)?;
    let mut paths = BTreeSet::new();
    let mut index = 0usize;
    while index < records.len() {
        let status = records[index];
        index += 1;
        if status.is_empty() {
            continue;
        }
        if status.contains('\t') {
            return Err(GitReadError::blocked(
                "Git returned a non-canonical name-status record.",
            ));
        }
        let path_count = if status.starts_with('R') || status.starts_with('C') {
            2
        } else if matches!(status.as_bytes()[0], b'A' | b'D' | b'M' | b'T' | b'U') {
            1
        } else {
            return Err(GitReadError::blocked(
                "Git returned an unsupported name-status code.",
            ));
        };
        if records.len().saturating_sub(index) < path_count {
            return Err(GitReadError::blocked(
                "Git returned an incomplete name-status record.",
            ));
        }
        for path in &records[index..index + path_count] {
            validate_git_path(path).map_err(GitReadError::blocked)?;
            paths.insert((*path).to_owned());
        }
        index += path_count;
    }
    Ok(paths)
}

fn parse_nul_paths(output: &[u8]) -> Result<BTreeSet<String>, GitReadError> {
    let mut paths = BTreeSet::new();
    for path in parse_utf8_nul_records(output)? {
        if path.is_empty() {
            continue;
        }
        validate_git_path(path).map_err(GitReadError::blocked)?;
        paths.insert(path.to_owned());
    }
    Ok(paths)
}

fn parse_utf8_nul_records(output: &[u8]) -> Result<Vec<&str>, GitReadError> {
    let text = std::str::from_utf8(output)
        .map_err(|_| GitReadError::blocked("Git returned a path that is not valid UTF-8."))?;
    Ok(text
        .split('\0')
        .filter(|record| !record.is_empty())
        .collect())
}

struct NulRecords<'a> {
    output: &'a [u8],
    offset: usize,
}

impl<'a> NulRecords<'a> {
    fn new(output: &'a [u8]) -> Self {
        Self { output, offset: 0 }
    }

    fn next_record(&mut self) -> Result<Option<&'a [u8]>, GitReadError> {
        if self.offset == self.output.len() {
            return Ok(None);
        }
        let Some(relative_end) = self.output[self.offset..]
            .iter()
            .position(|byte| *byte == 0)
        else {
            return Err(GitReadError::blocked(
                "Git returned a status record without a NUL terminator.",
            ));
        };
        let end = self.offset + relative_end;
        let record = &self.output[self.offset..end];
        self.offset = end + 1;
        Ok(Some(record))
    }
}

fn fingerprint_worktree_path(
    repository_root: &Path,
    path: &Path,
    cancellation: &AtomicBool,
) -> Result<GitWorktreeFingerprint, GitReadError> {
    reject_linked_worktree_ancestors(repository_root, path)?;
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(missing_fingerprint());
        }
        Err(error) => {
            return Err(GitReadError::blocked(format!(
                "Could not inspect a Git worktree path: {error}"
            )));
        }
    };
    let file_type = metadata.file_type();
    if is_windows_reparse_point(&metadata) && !file_type.is_symlink() {
        return Err(GitReadError::blocked(
            "A Git worktree path is an unsupported Windows reparse point.",
        ));
    }
    if file_type.is_file() {
        let canonical = fs::canonicalize(path).map_err(|error| {
            GitReadError::blocked(format!("Could not resolve a Git worktree file: {error}"))
        })?;
        let canonical_root = fs::canonicalize(repository_root).map_err(|error| {
            GitReadError::blocked(format!(
                "Could not resolve the Git repository root: {error}"
            ))
        })?;
        if !canonical_path_is_within(&canonical, &canonical_root) {
            return Err(GitReadError::blocked(
                "A Git worktree file resolves outside the repository root.",
            ));
        }
        let before_length = metadata.len();
        let before_modified = metadata.modified().ok();
        let (byte_length, sha256) = hash_file(path, cancellation)?;
        let after = fs::metadata(path).map_err(|error| {
            GitReadError::blocked(format!("Could not recheck a Git worktree file: {error}"))
        })?;
        if after.len() != before_length || after.modified().ok() != before_modified {
            return Err(GitReadError::blocked(
                "A Git worktree file changed during baseline capture.",
            ));
        }
        return Ok(GitWorktreeFingerprint {
            kind: GitWorktreePathKind::File,
            byte_length: Some(byte_length),
            sha256: Some(sha256),
        });
    }
    if file_type.is_symlink() {
        let target = fs::read_link(path).map_err(|error| {
            GitReadError::blocked(format!("Could not read a Git worktree symlink: {error}"))
        })?;
        let bytes = target.to_string_lossy();
        return Ok(GitWorktreeFingerprint {
            kind: GitWorktreePathKind::Symlink,
            byte_length: Some(u64::try_from(bytes.len()).unwrap_or(u64::MAX)),
            sha256: Some(sha256_hex(bytes.as_bytes())),
        });
    }
    Ok(GitWorktreeFingerprint {
        kind: if file_type.is_dir() {
            GitWorktreePathKind::Directory
        } else {
            GitWorktreePathKind::Other
        },
        byte_length: None,
        sha256: None,
    })
}

fn reject_linked_worktree_ancestors(
    repository_root: &Path,
    path: &Path,
) -> Result<(), GitReadError> {
    let relative = path
        .strip_prefix(repository_root)
        .map_err(|_| GitReadError::blocked("A Git worktree path escapes the repository root."))?;
    let mut current = repository_root.to_path_buf();
    let mut components = relative.components().peekable();
    while let Some(component) = components.next() {
        if components.peek().is_none() {
            break;
        }
        current.push(component);
        let metadata = match fs::symlink_metadata(&current) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => {
                return Err(GitReadError::blocked(format!(
                    "Could not inspect a Git worktree path ancestor: {error}"
                )))
            }
        };
        if metadata.file_type().is_symlink() || is_windows_reparse_point(&metadata) {
            return Err(GitReadError::blocked(
                "A Git worktree path traverses a link or reparse point.",
            ));
        }
    }
    Ok(())
}

fn is_windows_reparse_point(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    {
        let _ = metadata;
        false
    }
}

fn missing_fingerprint() -> GitWorktreeFingerprint {
    GitWorktreeFingerprint {
        kind: GitWorktreePathKind::Missing,
        byte_length: None,
        sha256: None,
    }
}

fn hash_file(path: &Path, cancellation: &AtomicBool) -> Result<(u64, String), GitReadError> {
    let mut file = File::open(path).map_err(|error| {
        GitReadError::blocked(format!("Could not read a Git state file: {error}"))
    })?;
    let mut hasher = Sha256::new();
    let mut byte_length = 0u64;
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        if cancellation.load(Ordering::Acquire) {
            return Err(GitReadError::cancelled(
                "Verification was cancelled while Git state was hashed.",
            ));
        }
        let read = file.read(&mut buffer).map_err(|error| {
            GitReadError::blocked(format!("Could not read a Git state file: {error}"))
        })?;
        if read == 0 {
            break;
        }
        byte_length = byte_length.saturating_add(u64::try_from(read).unwrap_or(u64::MAX));
        hasher.update(&buffer[..read]);
    }
    Ok((byte_length, hex_digest(hasher.finalize().as_slice())))
}

fn repository_identity(repository_root: &Path) -> String {
    let value = repository_root.to_string_lossy();
    #[cfg(windows)]
    let value = value.to_ascii_lowercase();
    sha256_hex(value.as_bytes())
}

fn validate_git_path(path: &str) -> Result<(), String> {
    if path.is_empty() || path.contains('\0') || path.contains('\\') {
        return Err("Git returned an invalid repository-relative path.".to_owned());
    }
    let candidate = Path::new(path);
    let bytes = path.as_bytes();
    let has_windows_drive_prefix =
        bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':';
    if has_windows_drive_prefix
        || candidate
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        || path
            .split('/')
            .any(|component| component.is_empty() || component == ".." || component == ".")
    {
        return Err("Git returned an unsafe repository-relative path.".to_owned());
    }
    Ok(())
}

fn path_from_git(path: &str) -> PathBuf {
    path.split('/').collect()
}

fn repository_path_from_git(repository_root: &Path, path: &str) -> Result<PathBuf, String> {
    validate_git_path(path)?;
    let relative = path_from_git(path);
    if relative
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("Git returned an unsafe repository-relative path.".to_owned());
    }

    let joined = repository_root.join(&relative);
    let contained = joined
        .strip_prefix(repository_root)
        .is_ok_and(|remainder| remainder == relative);
    if !contained {
        return Err("Git returned a path outside the repository root.".to_owned());
    }
    Ok(joined)
}

fn canonical_path_is_within(candidate: &Path, root: &Path) -> bool {
    #[cfg(windows)]
    {
        let candidate = candidate.to_string_lossy().to_ascii_lowercase();
        let root = root.to_string_lossy().to_ascii_lowercase();
        candidate == root
            || candidate
                .strip_prefix(&root)
                .is_some_and(|suffix| suffix.starts_with(['\\', '/']))
    }
    #[cfg(not(windows))]
    {
        candidate.starts_with(root)
    }
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn is_object_id(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn decode_trimmed_git_text<'a>(output: &'a [u8], label: &str) -> Result<&'a str, GitReadError> {
    let output = std::str::from_utf8(output)
        .map_err(|_| GitReadError::blocked(format!("Git returned an invalid {label}.")))?;
    let output = output.trim_end_matches(['\r', '\n']);
    if output.is_empty() || output.contains('\0') || output.contains('\n') || output.contains('\r')
    {
        return Err(GitReadError::blocked(format!(
            "Git returned an invalid {label}."
        )));
    }
    Ok(output)
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex_digest(Sha256::digest(bytes).as_slice())
}

fn hex_digest(bytes: &[u8]) -> String {
    use std::fmt::Write as _;

    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(output, "{byte:02x}");
    }
    output
}

struct GitCommandOutput {
    exit_code: Option<i32>,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    stderr_truncated: bool,
}

fn run_git_checked(
    git: &Path,
    execution_root: &Path,
    arguments: &[&str],
    cancellation: &AtomicBool,
    supervise: bool,
) -> Result<Vec<u8>, GitReadError> {
    let output = run_git(git, execution_root, arguments, cancellation, supervise)?;
    if output.exit_code != Some(0) {
        return Err(git_exit_error("read repository state", &output));
    }
    Ok(output.stdout)
}

fn run_git_checked_with_input(
    git: &Path,
    execution_root: &Path,
    arguments: &[&str],
    input: &[u8],
    cancellation: &AtomicBool,
    supervise: bool,
) -> Result<Vec<u8>, GitReadError> {
    let output = run_git_owned(
        git,
        execution_root,
        arguments.iter().map(|value| (*value).to_owned()).collect(),
        cancellation,
        supervise,
        Some(input),
    )?;
    if output.exit_code != Some(0) {
        return Err(git_exit_error("inspect tracked path attributes", &output));
    }
    Ok(output.stdout)
}

fn run_git_checked_owned(
    git: &Path,
    execution_root: &Path,
    arguments: Vec<String>,
    cancellation: &AtomicBool,
    supervise: bool,
) -> Result<Vec<u8>, GitReadError> {
    let output = run_git_owned(
        git,
        execution_root,
        arguments,
        cancellation,
        supervise,
        None,
    )?;
    if output.exit_code != Some(0) {
        return Err(git_exit_error("compare repository state", &output));
    }
    Ok(output.stdout)
}

fn run_git(
    git: &Path,
    execution_root: &Path,
    arguments: &[&str],
    cancellation: &AtomicBool,
    supervise: bool,
) -> Result<GitCommandOutput, GitReadError> {
    run_git_owned(
        git,
        execution_root,
        arguments.iter().map(|value| (*value).to_owned()).collect(),
        cancellation,
        supervise,
        None,
    )
}

fn run_git_owned(
    git: &Path,
    execution_root: &Path,
    arguments: Vec<String>,
    cancellation: &AtomicBool,
    supervise: bool,
    input: Option<&[u8]>,
) -> Result<GitCommandOutput, GitReadError> {
    run_git_owned_with_timeout(
        git,
        execution_root,
        arguments,
        cancellation,
        supervise,
        input,
        GIT_COMMAND_TIMEOUT,
    )
}

fn run_git_owned_with_timeout(
    git: &Path,
    execution_root: &Path,
    arguments: Vec<String>,
    cancellation: &AtomicBool,
    supervise: bool,
    input: Option<&[u8]>,
    timeout: Duration,
) -> Result<GitCommandOutput, GitReadError> {
    if cancellation.load(Ordering::Acquire) {
        return Err(GitReadError::cancelled(
            "Verification was cancelled before Git started.",
        ));
    }
    let started = Instant::now();
    let mut target = Command::new(git);
    configure_verification_git_command(&mut target, execution_root, &arguments);
    let mut command = if supervise {
        let supervised = if input.is_some() {
            supervise_process_tree_with_input(target)
        } else {
            supervise_process_tree(target)
        };
        supervised.map_err(|error| {
            GitReadError::blocked(format!("Could not prepare Git supervision: {error}"))
        })?
    } else {
        target
    };
    if input.is_some() {
        command.stdin(Stdio::piped());
    } else if !supervise {
        command.stdin(Stdio::null());
    }
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    hide_window(&mut command);
    let mut child = command
        .spawn()
        .map_err(|error| GitReadError::blocked(format!("Could not start Git: {error}")))?;
    let stdout = child.stdout.take().ok_or_else(|| {
        terminate_child(&mut child);
        GitReadError::blocked("The Git stdout pipe is unavailable.")
    })?;
    let stderr = child.stderr.take().ok_or_else(|| {
        terminate_child(&mut child);
        GitReadError::blocked("The Git stderr pipe is unavailable.")
    })?;

    let (sender, receiver) = mpsc::sync_channel(GIT_OUTPUT_CHANNEL_CAPACITY);
    let stdout_reader = spawn_reader(stdout, sender.clone(), GitStream::Stdout)?;
    let stderr_reader = match spawn_reader(stderr, sender, GitStream::Stderr) {
        Ok(reader) => reader,
        Err(error) => {
            terminate_child(&mut child);
            drain_one_reader(&receiver);
            let _ = stdout_reader.join();
            return Err(error);
        }
    };
    let stdin_writer = if let Some(input) = input {
        let stdin = child.stdin.take().ok_or_else(|| {
            terminate_child(&mut child);
            GitReadError::blocked("The Git stdin pipe is unavailable.")
        })?;
        match spawn_writer(stdin, input.to_vec()) {
            Ok(writer) => Some(writer),
            Err(error) => {
                terminate_child(&mut child);
                drain_one_reader(&receiver);
                drain_one_reader(&receiver);
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(error);
            }
        }
    } else {
        None
    };
    let mut stdout_capture = LimitedBytes::new(MAX_GIT_STDOUT_BYTES);
    let mut stderr_capture = LimitedBytes::new(MAX_GIT_STDERR_BYTES);
    let mut readers_finished = 0usize;
    let mut status: Option<ExitStatus> = None;
    let mut forced_error = None;

    while status.is_none() || readers_finished < 2 {
        match receiver.recv_timeout(GIT_POLL_INTERVAL) {
            Ok(GitOutputMessage::Chunk(stream, bytes)) => match stream {
                GitStream::Stdout => stdout_capture.push(&bytes),
                GitStream::Stderr => stderr_capture.push(&bytes),
            },
            Ok(GitOutputMessage::Error(error)) => {
                if forced_error.is_none() {
                    forced_error = Some(GitReadError::blocked(error));
                    terminate_child(&mut child);
                    status = child.try_wait().ok().flatten();
                }
            }
            Ok(GitOutputMessage::Finished) => readers_finished += 1,
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                if readers_finished < 2 && forced_error.is_none() {
                    forced_error = Some(GitReadError::blocked(
                        "Git output pipes closed unexpectedly.",
                    ));
                }
                readers_finished = 2;
            }
        }

        if stdout_capture.overflowed && forced_error.is_none() {
            forced_error = Some(GitReadError::blocked(format!(
                "Git output exceeded the {} byte safety limit.",
                MAX_GIT_STDOUT_BYTES
            )));
            terminate_child(&mut child);
            status = child.try_wait().ok().flatten();
        }
        if status.is_none() {
            match child.try_wait() {
                Ok(Some(exit_status)) => status = Some(exit_status),
                Ok(None) => {
                    if cancellation.load(Ordering::Acquire) {
                        forced_error = Some(GitReadError::cancelled(
                            "Verification was cancelled while Git was running.",
                        ));
                        terminate_child(&mut child);
                        status = child.try_wait().ok().flatten();
                    } else if started.elapsed() >= timeout {
                        forced_error = Some(GitReadError::blocked(
                            "Git timed out while reading repository state.",
                        ));
                        terminate_child(&mut child);
                        status = child.try_wait().ok().flatten();
                    }
                }
                Err(error) => {
                    forced_error = Some(GitReadError::blocked(format!(
                        "Could not inspect Git: {error}"
                    )));
                    terminate_child(&mut child);
                    status = child.try_wait().ok().flatten();
                }
            }
        }
        if status.is_some() && readers_finished >= 2 {
            break;
        }
    }

    if let Some(stdin_writer) = stdin_writer {
        match stdin_writer.join() {
            Ok(Ok(())) => {}
            Ok(Err(error)) if forced_error.is_none() => {
                forced_error = Some(GitReadError::blocked(error));
            }
            Err(_) if forced_error.is_none() => {
                forced_error = Some(GitReadError::blocked(
                    "The Git stdin writer stopped unexpectedly.",
                ));
            }
            Ok(Err(_)) | Err(_) => {}
        }
    }
    if stdout_reader.join().is_err() && forced_error.is_none() {
        forced_error = Some(GitReadError::blocked(
            "The Git stdout reader stopped unexpectedly.",
        ));
    }
    if stderr_reader.join().is_err() && forced_error.is_none() {
        forced_error = Some(GitReadError::blocked(
            "The Git stderr reader stopped unexpectedly.",
        ));
    }
    if let Some(error) = forced_error {
        return Err(error);
    }
    Ok(GitCommandOutput {
        exit_code: status.and_then(|status| status.code()),
        stdout: stdout_capture.bytes,
        stderr: stderr_capture.bytes,
        stderr_truncated: stderr_capture.overflowed,
    })
}

fn git_exit_error(operation: &str, output: &GitCommandOutput) -> GitReadError {
    let mut diagnostic = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    if diagnostic.is_empty() {
        diagnostic = "Git did not provide a diagnostic.".to_owned();
    }
    if output.stderr_truncated {
        diagnostic.push_str(" [diagnostic truncated]");
    }
    GitReadError::blocked(format!(
        "Could not {operation} (exit {:?}): {diagnostic}",
        output.exit_code
    ))
}

#[derive(Clone, Copy)]
enum GitStream {
    Stdout,
    Stderr,
}

enum GitOutputMessage {
    Chunk(GitStream, Vec<u8>),
    Error(String),
    Finished,
}

fn spawn_reader(
    mut reader: impl Read + Send + 'static,
    sender: SyncSender<GitOutputMessage>,
    stream: GitStream,
) -> Result<JoinHandle<()>, GitReadError> {
    let label = match stream {
        GitStream::Stdout => "stdout",
        GitStream::Stderr => "stderr",
    };
    thread::Builder::new()
        .name(format!("xiao-verification-git-{label}"))
        .spawn(move || {
            let mut buffer = vec![0u8; GIT_READ_CHUNK_BYTES];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(read) => {
                        if sender
                            .send(GitOutputMessage::Chunk(stream, buffer[..read].to_vec()))
                            .is_err()
                        {
                            return;
                        }
                    }
                    Err(error) => {
                        let _ = sender.send(GitOutputMessage::Error(format!(
                            "Could not read Git {label}: {error}"
                        )));
                        break;
                    }
                }
            }
            let _ = sender.send(GitOutputMessage::Finished);
        })
        .map_err(|error| {
            GitReadError::blocked(format!("Could not start the Git {label} reader: {error}"))
        })
}

fn spawn_writer(
    mut stdin: impl Write + Send + 'static,
    input: Vec<u8>,
) -> Result<JoinHandle<Result<(), String>>, GitReadError> {
    thread::Builder::new()
        .name("xiao-verification-git-stdin".to_owned())
        .spawn(move || {
            stdin
                .write_all(&input)
                .map_err(|error| format!("Could not write Git stdin: {error}"))
        })
        .map_err(|error| {
            GitReadError::blocked(format!("Could not start the Git stdin writer: {error}"))
        })
}

fn drain_one_reader(receiver: &Receiver<GitOutputMessage>) {
    let mut finished = false;
    while !finished {
        match receiver.recv_timeout(GIT_POLL_INTERVAL) {
            Ok(GitOutputMessage::Finished) | Err(RecvTimeoutError::Disconnected) => {
                finished = true;
            }
            Ok(_) | Err(RecvTimeoutError::Timeout) => {}
        }
    }
}

struct LimitedBytes {
    bytes: Vec<u8>,
    limit: usize,
    overflowed: bool,
}

impl LimitedBytes {
    fn new(limit: usize) -> Self {
        Self {
            bytes: Vec::new(),
            limit,
            overflowed: false,
        }
    }

    fn push(&mut self, bytes: &[u8]) {
        let remaining = self.limit.saturating_sub(self.bytes.len());
        let copied = remaining.min(bytes.len());
        self.bytes.extend_from_slice(&bytes[..copied]);
        self.overflowed |= copied < bytes.len();
    }
}

fn terminate_child(child: &mut std::process::Child) {
    let _ = child.kill();
    let _ = child.wait();
}

fn configure_verification_git_command(
    command: &mut Command,
    execution_root: &Path,
    arguments: &[String],
) {
    command.args(arguments).current_dir(execution_root);
    for variable in GIT_SELECTION_ENVIRONMENT_OVERRIDES {
        command.env_remove(variable);
    }
    for variable in GIT_CONFIG_ENVIRONMENT_OVERRIDES {
        command.env_remove(variable);
    }
    let numbered_config_overrides = std::env::vars_os()
        .map(|(key, _)| key)
        .chain(command.get_envs().map(|(key, _)| key.to_os_string()))
        .filter(|key| {
            let key = key.to_string_lossy().to_ascii_uppercase();
            key.starts_with("GIT_CONFIG_KEY_") || key.starts_with("GIT_CONFIG_VALUE_")
        })
        .collect::<Vec<_>>();
    for variable in numbered_config_overrides {
        command.env_remove(variable);
    }
    command
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", EMPTY_GIT_CONFIG_PATH)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "Never")
        .env("GIT_NO_LAZY_FETCH", "1")
        .env("GIT_NO_REPLACE_OBJECTS", "1")
        .env("LC_ALL", "C");
}

#[cfg(windows)]
fn hide_window(command: &mut Command) {
    use std::os::windows::process::CommandExt as _;
    use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_window(_command: &mut Command) {}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicBool;

    use super::*;

    struct TestRepository {
        path: PathBuf,
    }

    impl TestRepository {
        fn new(label: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "xiao-git-reader-{label}-{}",
                crate::runs::repository::new_uuid_v7()
            ));
            fs::create_dir_all(&path).unwrap();
            let repository = Self { path };
            repository.git_success(&["init", "--quiet", "--initial-branch=main"]);
            repository.git_success(&["config", "user.name", "Xiao Test"]);
            repository.git_success(&["config", "user.email", "xiao@example.invalid"]);
            repository.git_success(&["config", "core.autocrlf", "false"]);
            repository
        }

        fn write(&self, path: &str, value: &str) {
            let path = self.path.join(path_from_git(path));
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::write(path, value).unwrap();
        }

        fn git_success(&self, arguments: &[&str]) -> Vec<u8> {
            let output = self.git(arguments);
            assert!(
                output.status.success(),
                "git {arguments:?} failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            output.stdout
        }

        fn git_success_with_input(&self, arguments: &[&str], input: &[u8]) -> Vec<u8> {
            let mut command = Command::new("git");
            command
                .args(arguments)
                .current_dir(&self.path)
                .env("GIT_TERMINAL_PROMPT", "0")
                .env("GCM_INTERACTIVE", "Never")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            hide_window(&mut command);
            let mut child = command.spawn().unwrap();
            child.stdin.take().unwrap().write_all(input).unwrap();
            let output = child.wait_with_output().unwrap();
            assert!(
                output.status.success(),
                "git {arguments:?} failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            output.stdout
        }

        fn git_failure(&self, arguments: &[&str]) {
            let output = self.git(arguments);
            assert!(
                !output.status.success(),
                "git {arguments:?} unexpectedly passed"
            );
        }

        fn git(&self, arguments: &[&str]) -> std::process::Output {
            let mut command = Command::new("git");
            command
                .args(arguments)
                .current_dir(&self.path)
                .env("GIT_TERMINAL_PROMPT", "0")
                .env("GCM_INTERACTIVE", "Never")
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            hide_window(&mut command);
            command.output().unwrap()
        }

        fn commit_all(&self, message: &str) {
            self.git_success(&["add", "--all"]);
            self.git_success(&["commit", "--quiet", "-m", message]);
        }
    }

    impl Drop for TestRepository {
        fn drop(&mut self) {
            for _ in 0..10 {
                if fs::remove_dir_all(&self.path).is_ok() {
                    return;
                }
                thread::sleep(Duration::from_millis(25));
            }
        }
    }

    #[test]
    fn gitlink_preflight_rejects_head_gitlink_after_staged_deletion() {
        let repository = TestRepository::new("deleted-head-gitlink");
        repository.write(".gitignore", "nested/\n");
        repository.write("tracked.txt", "base");
        repository.commit_all("base");
        let target = String::from_utf8(repository.git_success(&["rev-parse", "HEAD"]))
            .unwrap()
            .trim()
            .to_owned();
        repository.git_success(&[
            "update-index",
            "--add",
            "--cacheinfo",
            "160000",
            &target,
            "nested",
        ]);
        repository.git_success(&["commit", "--quiet", "-m", "add synthetic gitlink"]);

        repository.git_success(&["rm", "--quiet", "--cached", "nested"]);
        repository.git_success(&["init", "--quiet", "nested"]);
        repository.write("nested/leftover.txt", "before");
        let status_before_edit = repository.git_success(&[
            "status",
            "--porcelain=v2",
            "-z",
            "--untracked-files=all",
            "--ignore-submodules=none",
        ]);
        repository.write("nested/leftover.txt", "changed after gitlink deletion");
        let status_after_edit = repository.git_success(&[
            "status",
            "--porcelain=v2",
            "-z",
            "--untracked-files=all",
            "--ignore-submodules=none",
        ]);
        assert_eq!(status_before_edit, status_after_edit);
        assert!(status_after_edit.starts_with(b"1 D."));
        assert!(repository
            .git_success(&["ls-files", "--stage", "--", "nested"])
            .is_empty());

        let error = capture_git_state(&repository.path, &AtomicBool::new(false)).unwrap_err();
        assert_eq!(error.outcome, VerificationGateOutcome::Blocked);
        assert!(error.diagnostic.contains("submodule entries"));
    }

    #[test]
    fn gitlink_preflight_rejects_index_only_gitlink_at_nonzero_stage() {
        let repository = TestRepository::new("index-stage-gitlink");
        repository.write("tracked.txt", "base");
        repository.commit_all("base");
        let target = String::from_utf8(repository.git_success(&["rev-parse", "HEAD"]))
            .unwrap()
            .trim()
            .to_owned();
        let index_info = format!("160000 {target} 2\tnested conflict\n");
        repository.git_success_with_input(&["update-index", "--index-info"], index_info.as_bytes());

        let error = capture_git_state(&repository.path, &AtomicBool::new(false)).unwrap_err();
        assert_eq!(error.outcome, VerificationGateOutcome::Blocked);
        assert!(error.diagnostic.contains("submodule entries"));
    }

    #[test]
    fn gitlink_preflight_allows_normal_tracked_directories() {
        let repository = TestRepository::new("normal-directory");
        repository.write("nested/ordinary.txt", "base");
        repository.commit_all("base");

        let baseline = capture_git_state(&repository.path, &AtomicBool::new(false)).unwrap();
        repository.write("nested/ordinary.txt", "changed");
        let final_state = capture_git_state(&repository.path, &AtomicBool::new(false)).unwrap();

        assert_eq!(
            status_delta_paths(&baseline, &final_state).unwrap(),
            vec!["nested/ordinary.txt"]
        );
    }

    #[test]
    fn porcelain_v2_parser_preserves_rename_copy_conflict_and_weird_paths() {
        let repository = TestRepository::new("parser");
        for path in [
            "ordinary path.txt",
            "renamed.txt",
            "copied.txt",
            "conflict.txt",
            "name with spaces ü.txt",
        ] {
            repository.write(path, path);
        }
        let output = concat!(
            "1 M. N... 100644 100644 100644 aaaa bbbb ordinary path.txt\0",
            "2 R. N... 100644 100644 100644 aaaa bbbb R100 renamed.txt\0",
            "old name.txt\0",
            "2 C. N... 100644 100644 100644 aaaa bbbb C100 copied.txt\0",
            "copy source.txt\0",
            "u UU N... 100644 100644 100644 100644 aaaa bbbb cccc conflict.txt\0",
            "? name with spaces ü.txt\0",
            "1 .D N... 100644 100644 100644 aaaa bbbb deleted.txt\0"
        );
        let entries =
            parse_porcelain_v2(output.as_bytes(), &repository.path, &AtomicBool::new(false))
                .unwrap();

        assert_eq!(entries.len(), 6);
        assert_eq!(entries[0].kind, GitStatusKind::Ordinary);
        assert_eq!(entries[1].kind, GitStatusKind::RenameOrCopy);
        assert_eq!(entries[1].original_path.as_deref(), Some("old name.txt"));
        assert_eq!(entries[2].kind, GitStatusKind::RenameOrCopy);
        assert_eq!(entries[2].original_path.as_deref(), Some("copy source.txt"));
        assert_eq!(entries[3].kind, GitStatusKind::Unmerged);
        assert_eq!(entries[4].path, "name with spaces ü.txt");
        assert!(entries[..5]
            .iter()
            .all(|entry| entry.worktree.kind == GitWorktreePathKind::File));
        assert_eq!(
            entries[4].worktree.sha256.as_deref(),
            Some(sha256_hex("name with spaces ü.txt".as_bytes()).as_str())
        );
        assert_eq!(entries[5].path, "deleted.txt");
        assert_eq!(entries[5].worktree.kind, GitWorktreePathKind::Missing);
    }

    #[test]
    fn native_status_disables_repository_fsmonitor_hooks() {
        let repository = TestRepository::new("fsmonitor-disabled");
        repository.write("tracked.txt", "tracked");
        repository.commit_all("base");
        let sentinel = repository.path.join("fsmonitor-invoked");
        #[cfg(windows)]
        let hook = {
            let hook = repository.path.join("fsmonitor-hook.cmd");
            fs::write(
                &hook,
                "@echo off\r\n>fsmonitor-invoked echo invoked\r\nexit /b 1\r\n",
            )
            .unwrap();
            hook
        };
        #[cfg(unix)]
        let hook = {
            use std::os::unix::fs::PermissionsExt as _;

            let hook = repository.path.join("fsmonitor-hook");
            fs::write(
                &hook,
                "#!/bin/sh\nprintf invoked > fsmonitor-invoked\nexit 1\n",
            )
            .unwrap();
            let mut permissions = fs::metadata(&hook).unwrap().permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(&hook, permissions).unwrap();
            hook
        };
        let hook = hook.to_string_lossy().into_owned();
        repository.git_success(&["config", "core.fsmonitor", &hook]);

        capture_git_state(&repository.path, &AtomicBool::new(false)).unwrap();

        assert!(!sentinel.exists());
    }

    #[test]
    fn active_clean_filter_blocks_before_git_status_can_launch_it() {
        let repository = TestRepository::new("filter-driver");
        repository.write("tracked.txt", "base");
        repository.commit_all("base");
        repository.write(".gitattributes", "tracked.txt filter=xiao\n");
        let command = if cfg!(windows) {
            "cmd /c echo invoked>filter-invoked"
        } else {
            "sh -c 'printf invoked > filter-invoked'"
        };
        repository.git_success(&["config", "filter.xiao.clean", command]);

        let error = capture_git_state(&repository.path, &AtomicBool::new(false)).unwrap_err();

        assert_eq!(error.outcome, VerificationGateOutcome::Blocked);
        assert!(error.diagnostic.contains("filter drivers"));
        assert!(!repository.path.join("filter-invoked").exists());
    }

    #[test]
    fn hidden_index_flags_block_instead_of_hiding_worktree_edits() {
        let repository = TestRepository::new("hidden-index-paths");
        repository.write("assumed.txt", "base");
        repository.write("sparse.txt", "base");
        repository.commit_all("base");

        repository.git_success(&["update-index", "--assume-unchanged", "assumed.txt"]);
        let assumed = capture_git_state(&repository.path, &AtomicBool::new(false)).unwrap_err();
        assert!(assumed.diagnostic.contains("assume-unchanged"));

        repository.git_success(&["update-index", "--no-assume-unchanged", "assumed.txt"]);
        repository.git_success(&["update-index", "--skip-worktree", "sparse.txt"]);
        let sparse = capture_git_state(&repository.path, &AtomicBool::new(false)).unwrap_err();
        assert!(sparse.diagnostic.contains("skip-worktree"));
    }

    #[test]
    fn nested_execution_root_blocks_instead_of_mis_scoping_git_paths() {
        let repository = TestRepository::new("nested-root");
        repository.write("packages/app/src/lib.rs", "tracked");
        repository.commit_all("base");
        let nested = repository.path.join("packages").join("app");

        let error = capture_git_state(&nested, &AtomicBool::new(false)).unwrap_err();

        assert_eq!(error.outcome, VerificationGateOutcome::Blocked);
        assert!(error.diagnostic.contains("repository top level"));
    }

    #[test]
    fn dirty_baseline_only_reports_final_run_owned_status_delta() {
        let repository = TestRepository::new("dirty-baseline");
        repository.write("preexisting.txt", "base");
        repository.write("rename-old.txt", "rename");
        repository.commit_all("base");
        repository.write("preexisting.txt", "dirty before run");

        let cancellation = AtomicBool::new(false);
        let baseline = capture_git_state(&repository.path, &cancellation).unwrap();
        assert!(baseline.index_sha256.is_some());
        let (_, baseline_unstaged, _) = full_status_paths(&baseline).unwrap();
        assert_eq!(baseline_unstaged, vec!["preexisting.txt"]);

        repository.write("src/new.rs", "fn main() {}");
        repository.write("src/name with spaces.rs", "pub fn spaced() {}");
        repository.git_success(&["mv", "rename-old.txt", "rename-new.txt"]);
        let final_state = capture_git_state(&repository.path, &cancellation).unwrap();
        let changed = status_delta_paths(&baseline, &final_state).unwrap();
        assert_eq!(
            changed,
            vec![
                "rename-new.txt",
                "rename-old.txt",
                "src/name with spaces.rs",
                "src/new.rs",
            ]
        );
        assert!(!changed.iter().any(|path| path == "preexisting.txt"));

        let (staged, unstaged, untracked) = full_status_paths(&final_state).unwrap();
        assert_eq!(staged, vec!["rename-new.txt", "rename-old.txt"]);
        assert_eq!(unstaged, vec!["preexisting.txt"]);
        assert_eq!(untracked, vec!["src/name with spaces.rs", "src/new.rs"]);

        repository.write("preexisting.txt", "changed during run");
        let changed_state = capture_git_state(&repository.path, &cancellation).unwrap();
        assert!(status_delta_paths(&baseline, &changed_state)
            .unwrap()
            .iter()
            .any(|path| path == "preexisting.txt"));

        let cancelled = capture_git_state(&repository.path, &AtomicBool::new(true)).unwrap_err();
        assert_eq!(cancelled.outcome, VerificationGateOutcome::Cancelled);
    }

    #[test]
    fn committed_delta_reports_both_rename_paths() {
        let repository = TestRepository::new("committed-delta");
        repository.write("old.txt", "content");
        repository.write("keep.txt", "base");
        repository.commit_all("base");
        let cancellation = AtomicBool::new(false);
        let baseline = capture_git_state(&repository.path, &cancellation).unwrap();

        repository.git_success(&["mv", "old.txt", "new.txt"]);
        repository.write("keep.txt", "changed");
        repository.commit_all("run changes");
        let final_state = capture_git_state(&repository.path, &cancellation).unwrap();
        assert!(status_delta_paths(&baseline, &final_state)
            .unwrap()
            .is_empty());

        let committed = read_committed_delta_paths(
            &repository.path,
            baseline.head_commit.as_deref(),
            final_state.head_commit.as_deref(),
            &cancellation,
        )
        .unwrap();
        assert_eq!(committed, vec!["keep.txt", "new.txt", "old.txt"]);
    }
    #[test]
    fn filter_attribute_output_must_cover_every_tracked_path() {
        let tracked = b"first.txt\0second.txt\0";
        let complete = b"first.txt\0filter\0unspecified\0second.txt\0filter\0unset\0";
        assert!(validate_filter_attribute_output(tracked, complete).is_ok());

        for incomplete in [
            &b""[..],
            &b"first.txt\0filter\0unspecified\0"[..],
            &b"second.txt\0filter\0unspecified\0first.txt\0filter\0unspecified\0"[..],
        ] {
            let error = validate_filter_attribute_output(tracked, incomplete).unwrap_err();
            assert_eq!(error.outcome, VerificationGateOutcome::Blocked);
        }
    }

    #[test]
    fn actual_merge_conflict_is_captured_as_staged_and_unstaged() {
        let repository = TestRepository::new("conflict");
        repository.write("conflict.txt", "base\n");
        repository.commit_all("base");
        repository.git_success(&["checkout", "--quiet", "-b", "other"]);
        repository.write("conflict.txt", "other\n");
        repository.commit_all("other");
        repository.git_success(&["checkout", "--quiet", "main"]);
        repository.write("conflict.txt", "main\n");
        repository.commit_all("main");
        repository.git_failure(&["merge", "--no-edit", "other"]);

        let snapshot = capture_git_state(&repository.path, &AtomicBool::new(false)).unwrap();
        let conflict = snapshot
            .entries
            .iter()
            .find(|entry| entry.path == "conflict.txt")
            .unwrap();
        assert_eq!(conflict.kind, GitStatusKind::Unmerged);
        let (staged, unstaged, untracked) = full_status_paths(&snapshot).unwrap();
        assert_eq!(staged, vec!["conflict.txt"]);
        assert_eq!(unstaged, vec!["conflict.txt"]);
        assert!(untracked.is_empty());
    }

    #[test]
    fn malformed_or_unsafe_git_records_fail_closed() {
        let repository = TestRepository::new("invalid");
        let cancellation = AtomicBool::new(false);
        assert!(parse_porcelain_v2(b"? ../escape\0", &repository.path, &cancellation).is_err());
        assert!(parse_porcelain_v2(
            b"2 R. N... 100644 100644 100644 a b R100 new.txt\0",
            &repository.path,
            &cancellation
        )
        .is_err());
        assert!(parse_name_status(b"R100\0only-one-path\0").is_err());
    }

    #[test]
    fn git_paths_are_normalized_repository_relative_strings() {
        for path in [
            "",
            ".",
            "./outside",
            "../outside",
            "inside/../outside",
            "inside/./outside",
            "inside//outside",
            "/outside",
            "//server/share/outside",
            "//?/C:/outside",
            r"\outside",
            r"\\server\share\outside",
            r"\\?\C:\outside",
            "C:outside",
            "C:/outside",
            r"C:\outside",
            "c:outside",
        ] {
            assert!(validate_git_path(path).is_err(), "{path:?} was accepted");
        }

        for path in [
            "ordinary.txt",
            "directory/name with spaces.txt",
            "directory/名前 ü.txt",
            "rename-old.txt",
            "rename-new.txt",
        ] {
            assert!(validate_git_path(path).is_ok(), "{path:?} was rejected");
        }
    }

    #[cfg(windows)]
    #[test]
    fn drive_relative_status_cannot_fingerprint_an_external_file() {
        use std::path::Prefix;

        struct RemoveSentinel(PathBuf);

        impl Drop for RemoveSentinel {
            fn drop(&mut self) {
                let _ = fs::remove_file(&self.0);
            }
        }

        let repository = TestRepository::new("drive-relative");
        let current_directory = std::env::current_dir().unwrap();
        let drive = current_directory
            .components()
            .find_map(|component| match component {
                Component::Prefix(prefix) => match prefix.kind() {
                    Prefix::Disk(drive) | Prefix::VerbatimDisk(drive) => Some(drive),
                    _ => None,
                },
                _ => None,
            })
            .expect("the Windows test directory must have a drive prefix");
        let sentinel_name = format!(
            "xiao-git-path-sentinel-{}",
            crate::runs::repository::new_uuid_v7()
        );
        let sentinel_path = current_directory.join(&sentinel_name);
        let _sentinel = RemoveSentinel(sentinel_path.clone());
        let sentinel_contents = b"external sentinel must not be fingerprinted";
        fs::write(&sentinel_path, sentinel_contents).unwrap();

        let malicious_path = format!("{}:{sentinel_name}", char::from(drive));
        let legacy_join = repository.path.join(path_from_git(&malicious_path));
        let (_, legacy_hash) = hash_file(&legacy_join, &AtomicBool::new(false)).unwrap();
        assert_eq!(legacy_hash, sha256_hex(sentinel_contents));

        assert!(repository_path_from_git(&repository.path, &malicious_path).is_err());
        let status = format!("? {malicious_path}\0");
        let error =
            parse_porcelain_v2(status.as_bytes(), &repository.path, &AtomicBool::new(false))
                .unwrap_err();
        assert_eq!(error.outcome, VerificationGateOutcome::Blocked);
    }

    #[test]
    fn verification_git_command_clears_repository_selection_environment() {
        let repository = TestRepository::new("command-environment");
        let arguments = vec!["status".to_owned(), "--porcelain=v2".to_owned()];
        let mut command = Command::new("git");
        for variable in GIT_SELECTION_ENVIRONMENT_OVERRIDES {
            command.env(variable, "hostile-ambient-value");
        }
        command
            .env("GIT_NO_REPLACE_OBJECTS", "0")
            .env("GIT_CONFIG", "hostile-config")
            .env("GIT_CONFIG_COUNT", "2")
            .env("GIT_CONFIG_KEY_0", "core.excludesFile")
            .env("GIT_CONFIG_VALUE_0", "hostile-excludes")
            .env("GIT_CONFIG_KEY_1", "core.hooksPath")
            .env("GIT_CONFIG_VALUE_1", "hostile-hooks")
            .env(
                "GIT_CONFIG_PARAMETERS",
                "'core.excludesFile=hostile-excludes'",
            )
            .env("GIT_CONFIG_SYSTEM", "hostile-system-config")
            .env("GIT_CONFIG_GLOBAL", "hostile-global-config")
            .env("GIT_CONFIG_NOSYSTEM", "0");

        configure_verification_git_command(&mut command, &repository.path, &arguments);

        for variable in GIT_SELECTION_ENVIRONMENT_OVERRIDES {
            let configured = command
                .get_envs()
                .find(|(key, _)| *key == std::ffi::OsStr::new(variable));
            assert!(
                matches!(configured, Some((_, None))),
                "{variable} was not removed from the Git command environment"
            );
        }
        for variable in [
            "GIT_CONFIG",
            "GIT_CONFIG_COUNT",
            "GIT_CONFIG_KEY_0",
            "GIT_CONFIG_VALUE_0",
            "GIT_CONFIG_KEY_1",
            "GIT_CONFIG_VALUE_1",
            "GIT_CONFIG_PARAMETERS",
            "GIT_CONFIG_SYSTEM",
        ] {
            let configured = command
                .get_envs()
                .find(|(key, _)| *key == std::ffi::OsStr::new(variable));
            assert!(
                matches!(configured, Some((_, None))),
                "{variable} was not removed from the Git command environment"
            );
        }
        for (variable, expected) in [
            ("GIT_CONFIG_NOSYSTEM", "1"),
            ("GIT_CONFIG_GLOBAL", EMPTY_GIT_CONFIG_PATH),
            ("GIT_NO_REPLACE_OBJECTS", "1"),
        ] {
            assert_eq!(
                command
                    .get_envs()
                    .find(|(key, _)| *key == std::ffi::OsStr::new(variable))
                    .and_then(|(_, value)| value),
                Some(std::ffi::OsStr::new(expected))
            );
        }

        let arguments = vec![
            "config".to_owned(),
            "--local".to_owned(),
            "--get".to_owned(),
            "core.autocrlf".to_owned(),
        ];
        let mut local_config_command = Command::new("git");
        configure_verification_git_command(&mut local_config_command, &repository.path, &arguments);
        let output = local_config_command.output().unwrap();
        assert!(output.status.success());
        assert_eq!(String::from_utf8(output.stdout).unwrap().trim(), "false");
    }

    #[cfg(windows)]
    #[test]
    fn git_for_windows_dev_null_ignores_global_config_without_creating_nul() {
        let repository = TestRepository::new("dev-null-global-config");
        let home = repository.path.join("ambient-home");
        fs::create_dir_all(&home).unwrap();
        fs::write(home.join(".gitconfig"), "[xiao]\n\tambient = visible\n").unwrap();
        let arguments = vec![
            "config".to_owned(),
            "--global".to_owned(),
            "--get".to_owned(),
            "xiao.ambient".to_owned(),
        ];

        let ambient = Command::new("git")
            .args(&arguments)
            .current_dir(&repository.path)
            .env("HOME", &home)
            .env("USERPROFILE", &home)
            .env_remove("GIT_CONFIG_GLOBAL")
            .output()
            .unwrap();
        assert!(ambient.status.success());
        assert_eq!(String::from_utf8(ambient.stdout).unwrap().trim(), "visible");

        let mut hardened = Command::new("git");
        hardened.env("HOME", &home).env("USERPROFILE", &home);
        configure_verification_git_command(&mut hardened, &repository.path, &arguments);
        let output = hardened.output().unwrap();
        assert_eq!(output.status.code(), Some(1));
        assert!(output.stdout.is_empty());

        capture_git_state(&repository.path, &AtomicBool::new(false)).unwrap();
        assert!(!fs::read_dir(&repository.path).unwrap().any(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .eq_ignore_ascii_case("nul")
        }));
    }

    #[test]
    fn injected_core_excludes_file_cannot_hide_untracked_path() {
        let repository = TestRepository::new("injected-excludes-file");
        repository.write("visible-untracked.txt", "must remain visible");
        let excludes_file = repository.path.join(".git").join("ambient-excludes");
        fs::write(&excludes_file, "visible-untracked.txt\n").unwrap();
        let arguments = vec![
            "-c".to_owned(),
            "core.quotepath=false".to_owned(),
            "status".to_owned(),
            "--porcelain=v2".to_owned(),
            "-z".to_owned(),
            "--untracked-files=all".to_owned(),
        ];

        let ambient_output = Command::new("git")
            .args(&arguments)
            .current_dir(&repository.path)
            .env("GIT_CONFIG_COUNT", "1")
            .env("GIT_CONFIG_KEY_0", "core.excludesFile")
            .env("GIT_CONFIG_VALUE_0", &excludes_file)
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
            .unwrap();
        assert!(ambient_output.status.success());
        assert!(
            ambient_output.stdout.is_empty(),
            "the injected excludes file fixture did not hide the untracked path"
        );

        let mut hardened_command = Command::new("git");
        hardened_command
            .env("GIT_CONFIG_COUNT", "1")
            .env("GIT_CONFIG_KEY_0", "core.excludesFile")
            .env("GIT_CONFIG_VALUE_0", &excludes_file);
        configure_verification_git_command(&mut hardened_command, &repository.path, &arguments);
        let hardened_output = hardened_command.output().unwrap();
        assert!(
            hardened_output.status.success(),
            "{}",
            String::from_utf8_lossy(&hardened_output.stderr)
        );
        let entries = parse_porcelain_v2(
            &hardened_output.stdout,
            &repository.path,
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].path, "visible-untracked.txt");
        assert_eq!(entries[0].kind, GitStatusKind::Untracked);
    }

    #[test]
    fn ambient_clean_alternate_index_cannot_hide_staged_changes() {
        let repository = TestRepository::new("alternate-index");
        repository.write("tracked.txt", "base");
        repository.commit_all("base");
        let clean_index = repository.path.join(".git").join("clean-index");
        fs::copy(repository.path.join(".git").join("index"), &clean_index).unwrap();

        repository.write("tracked.txt", "staged");
        repository.git_success(&["add", "tracked.txt"]);
        repository.write("tracked.txt", "base");

        let arguments = vec![
            "-c".to_owned(),
            "core.quotepath=false".to_owned(),
            "status".to_owned(),
            "--porcelain=v2".to_owned(),
            "-z".to_owned(),
        ];
        let ambient_output = Command::new("git")
            .args(&arguments)
            .current_dir(&repository.path)
            .env("GIT_INDEX_FILE", &clean_index)
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
            .unwrap();
        assert!(ambient_output.status.success());
        assert!(
            ambient_output.stdout.is_empty(),
            "the clean alternate index fixture did not hide the staged change"
        );

        let mut hardened_command = Command::new("git");
        hardened_command.env("GIT_INDEX_FILE", &clean_index);
        configure_verification_git_command(&mut hardened_command, &repository.path, &arguments);
        let hardened_output = hardened_command.output().unwrap();
        assert!(
            hardened_output.status.success(),
            "{}",
            String::from_utf8_lossy(&hardened_output.stderr)
        );
        let entries = parse_porcelain_v2(
            &hardened_output.stdout,
            &repository.path,
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].path, "tracked.txt");
        assert!(entries[0].is_staged());
    }

    #[test]
    fn replacement_refs_cannot_erase_committed_delta_paths() {
        let repository = TestRepository::new("replacement-ref");
        repository.write("base.txt", "base");
        repository.commit_all("base");
        let cancellation = AtomicBool::new(false);
        let baseline = capture_git_state(&repository.path, &cancellation).unwrap();

        repository.write("committed.txt", "delta");
        repository.commit_all("delta");
        let final_state = capture_git_state(&repository.path, &cancellation).unwrap();
        let baseline_head = baseline.head_commit.as_deref().unwrap();
        let final_head = final_state.head_commit.as_deref().unwrap();
        repository.git_success(&["replace", final_head, baseline_head]);
        assert!(repository
            .git_success(&["diff", "--name-only", baseline_head, final_head])
            .is_empty());

        let committed = read_committed_delta_paths(
            &repository.path,
            Some(baseline_head),
            Some(final_head),
            &cancellation,
        )
        .unwrap();

        assert_eq!(committed, vec!["committed.txt"]);
    }
    fn helper_arguments(name: &str) -> Vec<String> {
        vec![
            "--ignored".to_owned(),
            "--exact".to_owned(),
            format!("verification::git::tests::{name}"),
            "--nocapture".to_owned(),
        ]
    }

    #[test]
    #[ignore]
    fn finite_input_zero_helper() {
        let mut input = std::io::stdin().lock();
        let mut buffer = [0u8; 4096];
        loop {
            let read = input.read(&mut buffer).unwrap();
            if read == 0 {
                break;
            }
            thread::sleep(Duration::from_millis(1));
        }
        thread::sleep(Duration::from_millis(50));
    }

    #[test]
    #[ignore]
    fn finite_input_nonzero_helper() {
        let mut input = Vec::new();
        std::io::stdin().read_to_end(&mut input).unwrap();
        thread::sleep(Duration::from_millis(50));
        panic!(
            "intentional nonzero helper exit after {} input bytes",
            input.len()
        );
    }

    #[test]
    #[ignore]
    fn bidirectional_io_helper() {
        let output = vec![b'o'; 2 * 1024 * 1024];
        std::io::stdout().write_all(&output).unwrap();
        let mut input = Vec::new();
        std::io::stdin().read_to_end(&mut input).unwrap();
        assert_eq!(input.len(), 2 * 1024 * 1024);
    }

    #[test]
    #[ignore]
    fn blocked_stdin_helper() {
        thread::sleep(Duration::from_secs(10));
    }

    #[test]
    fn finite_input_waits_for_the_targets_real_exit_status() {
        let executable = std::env::current_exe().unwrap();
        let root = std::env::temp_dir();
        let input = vec![b'i'; 128 * 1024];
        let cancellation = AtomicBool::new(false);

        let success = run_git_owned(
            &executable,
            &root,
            helper_arguments("finite_input_zero_helper"),
            &cancellation,
            false,
            Some(&input),
        )
        .unwrap();
        assert_eq!(success.exit_code, Some(0));

        let failure = run_git_owned(
            &executable,
            &root,
            helper_arguments("finite_input_nonzero_helper"),
            &cancellation,
            false,
            Some(&input),
        )
        .unwrap();
        assert_ne!(failure.exit_code, Some(0));
    }

    #[test]
    fn large_bidirectional_finite_input_does_not_deadlock() {
        let input = vec![b'i'; 2 * 1024 * 1024];
        let output = run_git_owned(
            &std::env::current_exe().unwrap(),
            &std::env::temp_dir(),
            helper_arguments("bidirectional_io_helper"),
            &AtomicBool::new(false),
            false,
            Some(&input),
        )
        .unwrap();

        assert_eq!(output.exit_code, Some(0));
        assert!(output.stdout.len() >= 2 * 1024 * 1024);
    }

    #[test]
    fn cancellation_closes_finite_input_and_terminates_the_target() {
        let cancellation = std::sync::Arc::new(AtomicBool::new(false));
        let cancellation_signal = std::sync::Arc::clone(&cancellation);
        let signal = thread::spawn(move || {
            thread::sleep(Duration::from_millis(75));
            cancellation_signal.store(true, Ordering::Release);
        });
        let input = vec![b'i'; 8 * 1024 * 1024];
        let started = Instant::now();

        let error = run_git_owned_with_timeout(
            &std::env::current_exe().unwrap(),
            &std::env::temp_dir(),
            helper_arguments("blocked_stdin_helper"),
            &cancellation,
            false,
            Some(&input),
            Duration::from_secs(5),
        )
        .err()
        .unwrap();
        signal.join().unwrap();

        assert_eq!(error.outcome, VerificationGateOutcome::Cancelled);
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn timeout_closes_finite_input_and_terminates_the_target() {
        let input = vec![b'i'; 8 * 1024 * 1024];
        let started = Instant::now();
        let error = run_git_owned_with_timeout(
            &std::env::current_exe().unwrap(),
            &std::env::temp_dir(),
            helper_arguments("blocked_stdin_helper"),
            &AtomicBool::new(false),
            false,
            Some(&input),
            Duration::from_millis(100),
        )
        .err()
        .unwrap();

        assert_eq!(error.outcome, VerificationGateOutcome::Blocked);
        assert!(error.diagnostic.contains("timed out"));
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[cfg(windows)]
    struct WindowsJunction(PathBuf);

    #[cfg(windows)]
    impl WindowsJunction {
        fn create(link: PathBuf, target: &Path) -> Self {
            let status = Command::new("cmd")
                .args(["/d", "/c", "mklink", "/J"])
                .arg(&link)
                .arg(target)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .unwrap();
            assert!(
                status.success(),
                "could not create Windows junction fixture"
            );
            Self(link)
        }
    }

    #[cfg(windows)]
    impl Drop for WindowsJunction {
        fn drop(&mut self) {
            let _ = fs::remove_dir(&self.0);
        }
    }

    #[cfg(windows)]
    struct WindowsTestDirectory(PathBuf);

    #[cfg(windows)]
    impl WindowsTestDirectory {
        fn new(label: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "xiao-git-{label}-{}",
                crate::runs::repository::new_uuid_v7()
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    #[cfg(windows)]
    impl Drop for WindowsTestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[cfg(windows)]
    #[test]
    fn clean_tracked_file_below_windows_junction_blocks_capture() {
        let repository = TestRepository::new("clean-tracked-junction");
        repository.write(".gitignore", "tracked/sentinel.txt\n");
        repository.write("tracked/clean.txt", "tracked contents");
        repository.commit_all("base");

        let outside = WindowsTestDirectory::new("junction-outside");
        fs::write(outside.0.join("clean.txt"), "tracked contents").unwrap();
        let sentinel = outside.0.join("sentinel.txt");
        fs::write(&sentinel, "outside sentinel").unwrap();
        fs::remove_dir_all(repository.path.join("tracked")).unwrap();
        let _junction = WindowsJunction::create(repository.path.join("tracked"), &outside.0);

        let status =
            repository.git_success(&["status", "--porcelain=v2", "-z", "--untracked-files=all"]);
        assert!(status.is_empty(), "fixture must be absent from Git status");

        let error = capture_git_state(&repository.path, &AtomicBool::new(false)).unwrap_err();
        assert_eq!(error.outcome, VerificationGateOutcome::Blocked);
        assert!(error.diagnostic.contains("link or reparse point"));
        assert_eq!(fs::read_to_string(&sentinel).unwrap(), "outside sentinel");
    }
}
