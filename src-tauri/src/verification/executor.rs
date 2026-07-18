use std::collections::BTreeSet;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use regex::Regex;
use serde::Serialize;
use sha2::{Digest, Sha256};

use super::git::{
    full_status_paths, read_committed_delta_paths, status_delta_paths, GitStateSnapshot,
};
use super::models::{VerificationGateOutcome, MAX_PATH_PATTERN_BYTES};
use crate::process::supervise_process_tree;

const COMMAND_OUTPUT_HEAD_BYTES: usize = 256 * 1024;
const COMMAND_OUTPUT_TAIL_BYTES: usize = 256 * 1024;
const OUTPUT_READ_CHUNK_BYTES: usize = 16 * 1024;
const OUTPUT_CHANNEL_CAPACITY: usize = 32;
const COMMAND_POLL_INTERVAL: Duration = Duration::from_millis(10);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CommandEvidence {
    pub executable: String,
    pub argv: Vec<String>,
    pub output_head: String,
    pub output_tail: String,
    pub total_output_bytes: u64,
    pub output_truncated: bool,
    pub output_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CommandGateExecution {
    pub outcome: VerificationGateOutcome,
    pub duration_ms: u64,
    pub exit_code: Option<i32>,
    pub diagnostic: Option<String>,
    pub evidence: CommandEvidence,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NativeGateExecution<T> {
    pub outcome: VerificationGateOutcome,
    pub duration_ms: u64,
    pub diagnostic: Option<String>,
    pub evidence: T,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiffScopeEvidence {
    pub allowed_patterns: Vec<String>,
    pub denied_patterns: Vec<String>,
    pub changed_paths: Vec<String>,
    pub violating_paths: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CleanlinessEvidence {
    pub staged_paths: Vec<String>,
    pub unstaged_paths: Vec<String>,
    pub untracked_paths: Vec<String>,
    pub violating_staged_paths: Vec<String>,
    pub violating_unstaged_paths: Vec<String>,
    pub violating_untracked_paths: Vec<String>,
}

pub(crate) fn execute_diff_scope_gate(
    execution_root: &Path,
    baseline: &GitStateSnapshot,
    final_state: &GitStateSnapshot,
    allowed_patterns: &[String],
    denied_patterns: &[String],
    cancellation: &AtomicBool,
) -> NativeGateExecution<DiffScopeEvidence> {
    let started = Instant::now();
    let mut evidence = DiffScopeEvidence {
        allowed_patterns: allowed_patterns.to_vec(),
        denied_patterns: denied_patterns.to_vec(),
        changed_paths: Vec::new(),
        violating_paths: Vec::new(),
    };
    if cancellation.load(Ordering::Acquire) {
        return NativeGateExecution {
            outcome: VerificationGateOutcome::Cancelled,
            duration_ms: elapsed_millis(started),
            diagnostic: Some("Verification was cancelled before diff-scope evaluation.".to_owned()),
            evidence,
        };
    }
    let allowed = match compile_path_patterns(allowed_patterns) {
        Ok(patterns) => patterns,
        Err(error) => {
            return NativeGateExecution {
                outcome: VerificationGateOutcome::Blocked,
                duration_ms: elapsed_millis(started),
                diagnostic: Some(error),
                evidence,
            };
        }
    };
    let denied = match compile_path_patterns(denied_patterns) {
        Ok(patterns) => patterns,
        Err(error) => {
            return NativeGateExecution {
                outcome: VerificationGateOutcome::Blocked,
                duration_ms: elapsed_millis(started),
                diagnostic: Some(error),
                evidence,
            };
        }
    };
    let status_paths = match status_delta_paths(baseline, final_state) {
        Ok(paths) => paths,
        Err(error) => {
            return NativeGateExecution {
                outcome: VerificationGateOutcome::Blocked,
                duration_ms: elapsed_millis(started),
                diagnostic: Some(error),
                evidence,
            };
        }
    };
    let committed_paths = match read_committed_delta_paths(
        execution_root,
        baseline.head_commit.as_deref(),
        final_state.head_commit.as_deref(),
        cancellation,
    ) {
        Ok(paths) => paths,
        Err(error) => {
            evidence.changed_paths = status_paths;
            return NativeGateExecution {
                outcome: error.outcome,
                duration_ms: elapsed_millis(started),
                diagnostic: Some(error.diagnostic),
                evidence,
            };
        }
    };
    if cancellation.load(Ordering::Acquire) {
        evidence.changed_paths = status_paths;
        return NativeGateExecution {
            outcome: VerificationGateOutcome::Cancelled,
            duration_ms: elapsed_millis(started),
            diagnostic: Some("Verification was cancelled during diff-scope evaluation.".to_owned()),
            evidence,
        };
    }

    let mut changed_paths = status_paths.into_iter().collect::<BTreeSet<_>>();
    changed_paths.extend(committed_paths);
    evidence.changed_paths = changed_paths.into_iter().collect();
    evidence.violating_paths = evidence
        .changed_paths
        .iter()
        .filter(|path| {
            denied.iter().any(|pattern| pattern.matches(path))
                || (!allowed.is_empty() && !allowed.iter().any(|pattern| pattern.matches(path)))
        })
        .cloned()
        .collect();
    if evidence.violating_paths.is_empty() {
        NativeGateExecution {
            outcome: VerificationGateOutcome::Passed,
            duration_ms: elapsed_millis(started),
            diagnostic: None,
            evidence,
        }
    } else {
        NativeGateExecution {
            outcome: VerificationGateOutcome::Failed,
            duration_ms: elapsed_millis(started),
            diagnostic: Some(format!(
                "{} changed path(s) violate the diff-scope contract.",
                evidence.violating_paths.len()
            )),
            evidence,
        }
    }
}

pub(crate) fn execute_cleanliness_gate(
    final_state: &GitStateSnapshot,
    allow_staged: bool,
    allow_unstaged: bool,
    allow_untracked: bool,
    cancellation: &AtomicBool,
) -> NativeGateExecution<CleanlinessEvidence> {
    let started = Instant::now();
    if cancellation.load(Ordering::Acquire) {
        return NativeGateExecution {
            outcome: VerificationGateOutcome::Cancelled,
            duration_ms: elapsed_millis(started),
            diagnostic: Some(
                "Verification was cancelled before cleanliness evaluation.".to_owned(),
            ),
            evidence: CleanlinessEvidence {
                staged_paths: Vec::new(),
                unstaged_paths: Vec::new(),
                untracked_paths: Vec::new(),
                violating_staged_paths: Vec::new(),
                violating_unstaged_paths: Vec::new(),
                violating_untracked_paths: Vec::new(),
            },
        };
    }
    let (staged_paths, unstaged_paths, untracked_paths) = match full_status_paths(final_state) {
        Ok(paths) => paths,
        Err(error) => {
            return NativeGateExecution {
                outcome: VerificationGateOutcome::Blocked,
                duration_ms: elapsed_millis(started),
                diagnostic: Some(error),
                evidence: CleanlinessEvidence {
                    staged_paths: Vec::new(),
                    unstaged_paths: Vec::new(),
                    untracked_paths: Vec::new(),
                    violating_staged_paths: Vec::new(),
                    violating_unstaged_paths: Vec::new(),
                    violating_untracked_paths: Vec::new(),
                },
            };
        }
    };
    let violating_staged_paths = if allow_staged {
        Vec::new()
    } else {
        staged_paths.clone()
    };
    let violating_unstaged_paths = if allow_unstaged {
        Vec::new()
    } else {
        unstaged_paths.clone()
    };
    let violating_untracked_paths = if allow_untracked {
        Vec::new()
    } else {
        untracked_paths.clone()
    };
    let evidence = CleanlinessEvidence {
        staged_paths,
        unstaged_paths,
        untracked_paths,
        violating_staged_paths,
        violating_unstaged_paths,
        violating_untracked_paths,
    };
    let violation_count = evidence.violating_staged_paths.len()
        + evidence.violating_unstaged_paths.len()
        + evidence.violating_untracked_paths.len();
    if violation_count == 0 {
        NativeGateExecution {
            outcome: VerificationGateOutcome::Passed,
            duration_ms: elapsed_millis(started),
            diagnostic: None,
            evidence,
        }
    } else {
        NativeGateExecution {
            outcome: VerificationGateOutcome::Failed,
            duration_ms: elapsed_millis(started),
            diagnostic: Some(format!(
                "{violation_count} repository path state(s) violate the cleanliness contract."
            )),
            evidence,
        }
    }
}

#[derive(Debug, Clone)]
struct PathPattern {
    matcher: Regex,
}

impl PathPattern {
    fn compile(pattern: &str) -> Result<Self, String> {
        validate_path_pattern(pattern)?;
        let mut source = String::with_capacity(pattern.len() + 4);
        source.push_str(r"\A");
        let mut characters = pattern.chars().peekable();
        while let Some(character) = characters.next() {
            match character {
                '?' => source.push_str("[^/]"),
                '*' if characters.peek() == Some(&'*') => {
                    characters.next();
                    if characters.peek() == Some(&'/') {
                        characters.next();
                        source.push_str("(?s:.*/)?");
                    } else {
                        source.push_str("(?s:.*)");
                    }
                }
                '*' => source.push_str("[^/]*"),
                character => {
                    if matches!(
                        character,
                        '\\' | '.' | '+' | '(' | ')' | '|' | '[' | ']' | '{' | '}' | '^' | '$'
                    ) {
                        source.push('\\');
                    }
                    source.push(character);
                }
            }
        }
        source.push_str(r"\z");
        let matcher =
            Regex::new(&source).map_err(|_| "Diff-scope path patterns are invalid.".to_owned())?;
        Ok(Self { matcher })
    }

    fn matches(&self, path: &str) -> bool {
        self.matcher.is_match(path)
    }
}

fn compile_path_patterns(patterns: &[String]) -> Result<Vec<PathPattern>, String> {
    patterns
        .iter()
        .map(|pattern| PathPattern::compile(pattern))
        .collect()
}

fn validate_path_pattern(pattern: &str) -> Result<(), String> {
    if pattern.is_empty() || pattern.contains('\\') || pattern.contains('\0') {
        return Err("Diff-scope path patterns are invalid.".to_owned());
    }
    if pattern.len() > MAX_PATH_PATTERN_BYTES {
        return Err("Diff-scope path patterns are too large.".to_owned());
    }
    let bytes = pattern.as_bytes();
    if pattern.starts_with('/')
        || (bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':')
        || pattern.split('/').any(|segment| segment == "..")
    {
        return Err("Diff-scope path patterns must be safe relative paths.".to_owned());
    }
    Ok(())
}

pub(crate) fn execute_command_gate(
    execution_root: &Path,
    executable: &str,
    argv: &[String],
    timeout_ms: u64,
    expected_exit_codes: &[i32],
    cancellation: &AtomicBool,
) -> CommandGateExecution {
    execute_command_gate_with_supervision(
        execution_root,
        executable,
        argv,
        timeout_ms,
        expected_exit_codes,
        cancellation,
        !cfg!(test),
    )
}

fn execute_command_gate_with_supervision(
    execution_root: &Path,
    executable: &str,
    argv: &[String],
    timeout_ms: u64,
    expected_exit_codes: &[i32],
    cancellation: &AtomicBool,
    supervise: bool,
) -> CommandGateExecution {
    let started = Instant::now();
    let mut output = BoundedOutput::default();
    let resolved = match resolve_command_executable(execution_root, executable) {
        Ok(resolved) => resolved,
        Err(error) => {
            return blocked_command_execution(
                started,
                executable.to_owned(),
                argv.to_vec(),
                output,
                error,
            );
        }
    };
    let resolved_display = display_path(&resolved);
    if cancellation.load(Ordering::Acquire) {
        return CommandGateExecution {
            outcome: VerificationGateOutcome::Cancelled,
            duration_ms: elapsed_millis(started),
            exit_code: None,
            diagnostic: Some("Verification was cancelled before the command started.".to_owned()),
            evidence: output.finish(resolved_display, argv.to_vec()),
        };
    }

    let execution_root = match fs::canonicalize(execution_root) {
        Ok(root) if root.is_dir() => root,
        Ok(_) => {
            return blocked_command_execution(
                started,
                resolved_display,
                argv.to_vec(),
                output,
                "The stored run execution root is not a directory.".to_owned(),
            );
        }
        Err(error) => {
            return blocked_command_execution(
                started,
                resolved_display,
                argv.to_vec(),
                output,
                format!("Could not resolve the stored run execution root: {error}"),
            );
        }
    };

    let mut target = Command::new(&resolved);
    target.args(argv).current_dir(execution_root);
    let mut command = if supervise {
        match supervise_process_tree(target) {
            Ok(command) => command,
            Err(error) => {
                return blocked_command_execution(
                    started,
                    resolved_display,
                    argv.to_vec(),
                    output,
                    format!("Could not prepare command supervision: {error}"),
                );
            }
        }
    } else {
        target
    };
    if !supervise {
        command.stdin(Stdio::null());
    }
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    hide_window(&mut command);

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return blocked_command_execution(
                started,
                resolved_display,
                argv.to_vec(),
                output,
                format!("Could not start the verification command: {error}"),
            );
        }
    };
    let Some(stdout) = child.stdout.take() else {
        terminate_child(&mut child);
        return blocked_command_execution(
            started,
            resolved_display,
            argv.to_vec(),
            output,
            "The verification command stdout pipe is unavailable.".to_owned(),
        );
    };
    let Some(stderr) = child.stderr.take() else {
        terminate_child(&mut child);
        return blocked_command_execution(
            started,
            resolved_display,
            argv.to_vec(),
            output,
            "The verification command stderr pipe is unavailable.".to_owned(),
        );
    };

    let (sender, receiver) = mpsc::sync_channel(OUTPUT_CHANNEL_CAPACITY);
    let stdout_reader = spawn_output_reader(stdout, sender.clone(), "stdout");
    let stderr_reader = spawn_output_reader(stderr, sender, "stderr");
    let timeout = Duration::from_millis(timeout_ms);
    let mut status: Option<ExitStatus> = None;
    let mut readers_finished = 0usize;
    let mut stream_error = None;
    let mut forced_outcome = None;

    while status.is_none() || readers_finished < 2 {
        receive_output(
            &receiver,
            &mut output,
            &mut readers_finished,
            &mut stream_error,
        );

        if status.is_none() {
            match child.try_wait() {
                Ok(Some(exit_status)) => status = Some(exit_status),
                Ok(None) => {
                    if cancellation.load(Ordering::Acquire) {
                        forced_outcome = Some((
                            VerificationGateOutcome::Cancelled,
                            "Verification was cancelled while the command was running.".to_owned(),
                        ));
                        terminate_child(&mut child);
                        status = child.try_wait().ok().flatten();
                    } else if started.elapsed() >= timeout {
                        forced_outcome = Some((
                            VerificationGateOutcome::Blocked,
                            format!("The verification command timed out after {timeout_ms} ms."),
                        ));
                        terminate_child(&mut child);
                        status = child.try_wait().ok().flatten();
                    }
                }
                Err(error) => {
                    forced_outcome = Some((
                        VerificationGateOutcome::Blocked,
                        format!("Could not inspect the verification command: {error}"),
                    ));
                    terminate_child(&mut child);
                    status = child.try_wait().ok().flatten();
                }
            }
        }

        if status.is_some() && readers_finished >= 2 {
            break;
        }
    }

    join_output_reader(stdout_reader, "stdout", &mut stream_error);
    join_output_reader(stderr_reader, "stderr", &mut stream_error);
    while let Ok(message) = receiver.try_recv() {
        apply_output_message(
            message,
            &mut output,
            &mut readers_finished,
            &mut stream_error,
        );
    }

    let evidence = output.finish(resolved_display, argv.to_vec());
    if let Some((outcome, diagnostic)) = forced_outcome {
        return CommandGateExecution {
            outcome,
            duration_ms: elapsed_millis(started),
            exit_code: status.and_then(|status| status.code()),
            diagnostic: Some(diagnostic),
            evidence,
        };
    }
    if let Some(error) = stream_error {
        return CommandGateExecution {
            outcome: VerificationGateOutcome::Blocked,
            duration_ms: elapsed_millis(started),
            exit_code: status.and_then(|status| status.code()),
            diagnostic: Some(error),
            evidence,
        };
    }

    let exit_code = status.and_then(|status| status.code());
    match exit_code {
        Some(exit_code) if expected_exit_codes.contains(&exit_code) => CommandGateExecution {
            outcome: VerificationGateOutcome::Passed,
            duration_ms: elapsed_millis(started),
            exit_code: Some(exit_code),
            diagnostic: None,
            evidence,
        },
        Some(exit_code) => CommandGateExecution {
            outcome: VerificationGateOutcome::Failed,
            duration_ms: elapsed_millis(started),
            exit_code: Some(exit_code),
            diagnostic: Some(format!(
                "The verification command exited with code {exit_code}; expected one of {expected_exit_codes:?}."
            )),
            evidence,
        },
        None => CommandGateExecution {
            outcome: VerificationGateOutcome::Blocked,
            duration_ms: elapsed_millis(started),
            exit_code: None,
            diagnostic: Some("The verification command ended without an exit code.".to_owned()),
            evidence,
        },
    }
}

pub(crate) fn resolve_command_executable(
    execution_root: &Path,
    executable: &str,
) -> Result<PathBuf, String> {
    let path_environment = std::env::var_os("PATH");
    let path_extensions = std::env::var_os("PATHEXT");
    resolve_command_executable_with_environment(
        execution_root,
        executable,
        path_environment.as_deref(),
        path_extensions.as_deref(),
    )
}

pub(super) fn resolve_command_executable_with_environment(
    execution_root: &Path,
    executable: &str,
    path_environment: Option<&OsStr>,
    path_extensions: Option<&OsStr>,
) -> Result<PathBuf, String> {
    let executable = executable.trim();
    if executable.is_empty() {
        return Err("The verification command executable is empty.".to_owned());
    }
    let execution_root = fs::canonicalize(execution_root)
        .map_err(|error| format!("Could not resolve the stored run execution root: {error}"))?;
    if !execution_root.is_dir() {
        return Err("The stored run execution root is not a directory.".to_owned());
    }
    let requested = Path::new(executable);
    if is_bare_executable(requested) {
        return resolve_bare_executable(
            &execution_root,
            executable,
            path_environment,
            path_extensions,
        )
        .ok_or_else(|| {
            format!("Could not resolve verification executable `{executable}` on PATH.")
        });
    }

    let candidate = if requested.is_absolute() {
        requested.to_path_buf()
    } else {
        execution_root.join(requested)
    };
    let candidate = fs::canonicalize(&candidate).map_err(|error| {
        format!(
            "Could not resolve verification executable `{}`: {error}",
            candidate.display()
        )
    })?;
    if !requested.is_absolute() && !path_is_within(&candidate, &execution_root) {
        return Err("Relative verification executables must stay inside the run root.".to_owned());
    }
    if !is_executable_file(&candidate) {
        return Err("The verification command executable is not a runnable file.".to_owned());
    }
    Ok(candidate)
}

fn resolve_bare_executable(
    execution_root: &Path,
    executable: &str,
    path_environment: Option<&OsStr>,
    path_extensions: Option<&OsStr>,
) -> Option<PathBuf> {
    let path_environment = path_environment?;
    for directory in std::env::split_paths(path_environment) {
        if !directory.is_absolute() {
            continue;
        }
        if path_is_within(&directory, execution_root) {
            continue;
        }
        let Ok(canonical_directory) = fs::canonicalize(&directory) else {
            continue;
        };
        if path_is_within(&canonical_directory, execution_root) {
            continue;
        }
        for file_name in executable_file_names(executable, path_extensions) {
            let candidate = directory.join(file_name);
            if !is_executable_file(&candidate) {
                continue;
            }
            let Ok(candidate) = fs::canonicalize(candidate) else {
                continue;
            };
            if path_is_within(&candidate, execution_root) {
                continue;
            }
            return Some(candidate);
        }
    }
    None
}

fn is_bare_executable(path: &Path) -> bool {
    !path.is_absolute()
        && path
            .parent()
            .is_some_and(|parent| parent.as_os_str().is_empty())
        && path.file_name().is_some()
}

#[cfg(windows)]
fn executable_file_names(executable: &str, path_extensions: Option<&OsStr>) -> Vec<OsString> {
    if Path::new(executable).extension().is_some() {
        return vec![OsString::from(executable)];
    }
    let extensions = path_extensions
        .map(|value| {
            value
                .to_string_lossy()
                .split(';')
                .filter(|extension| !extension.trim().is_empty())
                .map(|extension| extension.trim().to_owned())
                .collect::<Vec<_>>()
        })
        .filter(|extensions| !extensions.is_empty())
        .unwrap_or_else(|| {
            vec![
                ".COM".to_owned(),
                ".EXE".to_owned(),
                ".BAT".to_owned(),
                ".CMD".to_owned(),
            ]
        });
    extensions
        .into_iter()
        .map(|extension| {
            let mut file_name = OsString::from(executable);
            file_name.push(extension);
            file_name
        })
        .collect()
}

#[cfg(not(windows))]
fn executable_file_names(executable: &str, _path_extensions: Option<&OsStr>) -> Vec<OsString> {
    vec![OsString::from(executable)]
}

#[cfg(windows)]
fn is_executable_file(path: &Path) -> bool {
    path.is_file()
}

#[cfg(unix)]
fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt as _;

    path.metadata()
        .is_ok_and(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
}

fn path_is_within(candidate: &Path, root: &Path) -> bool {
    #[cfg(windows)]
    {
        let candidate = display_path(candidate).to_ascii_lowercase();
        let root = display_path(root).to_ascii_lowercase();
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

fn display_path(path: &Path) -> String {
    let value = path.to_string_lossy();
    #[cfg(windows)]
    {
        if let Some(path) = value.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{path}");
        }
        if let Some(path) = value.strip_prefix(r"\\?\") {
            return path.to_owned();
        }
    }
    value.into_owned()
}

fn blocked_command_execution(
    started: Instant,
    executable: String,
    argv: Vec<String>,
    output: BoundedOutput,
    diagnostic: String,
) -> CommandGateExecution {
    CommandGateExecution {
        outcome: VerificationGateOutcome::Blocked,
        duration_ms: elapsed_millis(started),
        exit_code: None,
        diagnostic: Some(diagnostic),
        evidence: output.finish(executable, argv),
    }
}

fn elapsed_millis(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

fn terminate_child(child: &mut std::process::Child) {
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(windows)]
fn hide_window(command: &mut Command) {
    use std::os::windows::process::CommandExt as _;
    use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_window(_command: &mut Command) {}

enum OutputMessage {
    Chunk(Vec<u8>),
    Error(String),
    Finished,
}

fn spawn_output_reader(
    mut reader: impl Read + Send + 'static,
    sender: SyncSender<OutputMessage>,
    label: &'static str,
) -> JoinHandle<()> {
    thread::Builder::new()
        .name(format!("xiao-verification-{label}"))
        .spawn(move || {
            let mut chunk = vec![0u8; OUTPUT_READ_CHUNK_BYTES];
            loop {
                match reader.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(read) => {
                        if sender
                            .send(OutputMessage::Chunk(chunk[..read].to_vec()))
                            .is_err()
                        {
                            return;
                        }
                    }
                    Err(error) => {
                        let _ = sender.send(OutputMessage::Error(format!(
                            "Could not read verification command {label}: {error}"
                        )));
                        break;
                    }
                }
            }
            let _ = sender.send(OutputMessage::Finished);
        })
        .unwrap_or_else(|error| panic!("Could not start verification output reader: {error}"))
}

fn receive_output(
    receiver: &Receiver<OutputMessage>,
    output: &mut BoundedOutput,
    readers_finished: &mut usize,
    stream_error: &mut Option<String>,
) {
    match receiver.recv_timeout(COMMAND_POLL_INTERVAL) {
        Ok(message) => apply_output_message(message, output, readers_finished, stream_error),
        Err(RecvTimeoutError::Timeout) => {}
        Err(RecvTimeoutError::Disconnected) => {
            if *readers_finished < 2 && stream_error.is_none() {
                *stream_error =
                    Some("Verification command output pipes closed unexpectedly.".to_owned());
                *readers_finished = 2;
            }
        }
    }
}

fn apply_output_message(
    message: OutputMessage,
    output: &mut BoundedOutput,
    readers_finished: &mut usize,
    stream_error: &mut Option<String>,
) {
    match message {
        OutputMessage::Chunk(bytes) => output.push(&bytes),
        OutputMessage::Error(error) => {
            if stream_error.is_none() {
                *stream_error = Some(error);
            }
        }
        OutputMessage::Finished => *readers_finished += 1,
    }
}

fn join_output_reader(reader: JoinHandle<()>, label: &str, stream_error: &mut Option<String>) {
    if reader.join().is_err() && stream_error.is_none() {
        *stream_error = Some(format!(
            "The verification command {label} reader stopped unexpectedly."
        ));
    }
}

#[derive(Default)]
struct BoundedOutput {
    head: Vec<u8>,
    tail: TailBuffer,
    total_bytes: u64,
    hasher: Sha256,
}

impl BoundedOutput {
    fn push(&mut self, bytes: &[u8]) {
        self.total_bytes = self
            .total_bytes
            .saturating_add(u64::try_from(bytes.len()).unwrap_or(u64::MAX));
        self.hasher.update(bytes);
        let head_remaining = COMMAND_OUTPUT_HEAD_BYTES.saturating_sub(self.head.len());
        let head_bytes = head_remaining.min(bytes.len());
        self.head.extend_from_slice(&bytes[..head_bytes]);
        self.tail.push(&bytes[head_bytes..]);
    }

    fn finish(self, executable: String, argv: Vec<String>) -> CommandEvidence {
        let tail = self.tail.into_bytes();
        CommandEvidence {
            executable,
            argv,
            output_head: String::from_utf8_lossy(&self.head).into_owned(),
            output_tail: String::from_utf8_lossy(&tail).into_owned(),
            total_output_bytes: self.total_bytes,
            output_truncated: self.total_bytes
                > u64::try_from(COMMAND_OUTPUT_HEAD_BYTES + COMMAND_OUTPUT_TAIL_BYTES)
                    .unwrap_or(u64::MAX),
            output_sha256: hex_digest(self.hasher.finalize().as_slice()),
        }
    }
}

#[derive(Default)]
struct TailBuffer {
    bytes: Vec<u8>,
    cursor: usize,
    full: bool,
}

impl TailBuffer {
    fn push(&mut self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        if self.bytes.len() < COMMAND_OUTPUT_TAIL_BYTES {
            let available = COMMAND_OUTPUT_TAIL_BYTES - self.bytes.len();
            let copied = available.min(bytes.len());
            self.bytes.extend_from_slice(&bytes[..copied]);
            if copied == bytes.len() {
                return;
            }
            self.full = true;
            self.cursor = 0;
            self.push_full(&bytes[copied..]);
            return;
        }
        self.full = true;
        self.push_full(bytes);
    }

    fn push_full(&mut self, bytes: &[u8]) {
        if bytes.len() >= COMMAND_OUTPUT_TAIL_BYTES {
            self.bytes.clear();
            self.bytes
                .extend_from_slice(&bytes[bytes.len() - COMMAND_OUTPUT_TAIL_BYTES..]);
            self.cursor = 0;
            self.full = true;
            return;
        }
        let first = (COMMAND_OUTPUT_TAIL_BYTES - self.cursor).min(bytes.len());
        self.bytes[self.cursor..self.cursor + first].copy_from_slice(&bytes[..first]);
        let remaining = bytes.len() - first;
        if remaining > 0 {
            self.bytes[..remaining].copy_from_slice(&bytes[first..]);
        }
        self.cursor = (self.cursor + bytes.len()) % COMMAND_OUTPUT_TAIL_BYTES;
    }

    fn into_bytes(self) -> Vec<u8> {
        if !self.full || self.cursor == 0 {
            return self.bytes;
        }
        let mut ordered = Vec::with_capacity(self.bytes.len());
        ordered.extend_from_slice(&self.bytes[self.cursor..]);
        ordered.extend_from_slice(&self.bytes[..self.cursor]);
        ordered
    }
}

fn hex_digest(bytes: &[u8]) -> String {
    use std::fmt::Write as _;

    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(encoded, "{byte:02x}");
    }
    encoded
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::verification::git::{
        GitStatusEntry, GitStatusKind, GitWorktreeFingerprint, GitWorktreePathKind,
    };

    use std::io::Write as _;
    fn fixture_arguments(test_name: &str) -> Vec<String> {
        vec![
            "--ignored".to_owned(),
            "--exact".to_owned(),
            format!("verification::executor::tests::{test_name}"),
            "--nocapture".to_owned(),
            "--test-threads=1".to_owned(),
        ]
    }

    fn fingerprint(value: &str) -> GitWorktreeFingerprint {
        GitWorktreeFingerprint {
            kind: GitWorktreePathKind::File,
            byte_length: Some(u64::try_from(value.len()).unwrap()),
            sha256: Some(hex_digest(Sha256::digest(value.as_bytes()).as_slice())),
        }
    }

    fn status_entry(
        kind: GitStatusKind,
        path: &str,
        original_path: Option<&str>,
        index_status: Option<char>,
        worktree_status: Option<char>,
        content: &str,
    ) -> GitStatusEntry {
        GitStatusEntry {
            kind,
            path: path.to_owned(),
            original_path: original_path.map(ToOwned::to_owned),
            index_status,
            worktree_status,
            metadata: if kind == GitStatusKind::Untracked {
                Vec::new()
            } else {
                vec!["stable".to_owned()]
            },
            worktree: fingerprint(content),
        }
    }

    fn git_state(entries: Vec<GitStatusEntry>) -> GitStateSnapshot {
        let mut entries = entries;
        entries.sort_by(|left, right| {
            (&left.path, &left.original_path).cmp(&(&right.path, &right.original_path))
        });
        GitStateSnapshot {
            schema_version: 1,
            repository_identity_sha256: "a".repeat(64),
            head_commit: Some("b".repeat(40)),
            index_sha256: Some("c".repeat(64)),
            entries,
        }
    }

    #[test]
    fn path_globs_respect_segments_globstar_unicode_and_literal_brackets() {
        let root_rust = PathPattern::compile("*.rs").unwrap();
        assert!(root_rust.matches("lib.rs"));
        assert!(!root_rust.matches("src/lib.rs"));

        let recursive_rust = PathPattern::compile("**/*.rs").unwrap();
        assert!(recursive_rust.matches("lib.rs"));
        assert!(recursive_rust.matches("src/deep/lib.rs"));
        assert!(!recursive_rust.matches("src/lib.ts"));

        let test_pattern = PathPattern::compile("src/**/test?.rs").unwrap();
        assert!(test_pattern.matches("src/test1.rs"));
        assert!(test_pattern.matches("src/deep/testü.rs"));
        assert!(!test_pattern.matches("src/deep/test12.rs"));
        assert!(PathPattern::compile("src/[literal].rs")
            .unwrap()
            .matches("src/[literal].rs"));
    }

    #[test]
    fn path_glob_compilation_is_bounded_for_untrusted_contracts() {
        let oversized = "*".repeat(MAX_PATH_PATTERN_BYTES + 1);
        assert!(PathPattern::compile(&oversized).is_err());

        let bounded = format!("{}z", "*a".repeat(MAX_PATH_PATTERN_BYTES / 4));
        let path = "a".repeat(MAX_PATH_PATTERN_BYTES / 4);
        assert!(!PathPattern::compile(&bounded).unwrap().matches(&path));
    }

    #[test]
    fn diff_scope_uses_run_owned_delta_and_denied_patterns_win() {
        let preexisting = status_entry(
            GitStatusKind::Ordinary,
            "preexisting.txt",
            None,
            Some('.'),
            Some('M'),
            "dirty-before-run",
        );
        let baseline = git_state(vec![preexisting.clone()]);
        let allowed_entry = status_entry(
            GitStatusKind::Untracked,
            "src/lib.rs",
            None,
            None,
            None,
            "allowed",
        );
        let allowed_state = git_state(vec![preexisting.clone(), allowed_entry.clone()]);
        let passed = execute_diff_scope_gate(
            Path::new("unused-for-equal-head"),
            &baseline,
            &allowed_state,
            &["src/**".to_owned()],
            &["src/generated/**".to_owned()],
            &AtomicBool::new(false),
        );
        assert_eq!(passed.outcome, VerificationGateOutcome::Passed);
        assert_eq!(passed.evidence.changed_paths, vec!["src/lib.rs"]);
        assert!(!passed
            .evidence
            .changed_paths
            .iter()
            .any(|path| path == "preexisting.txt"));

        let denied_entry = status_entry(
            GitStatusKind::Untracked,
            "src/generated/code.rs",
            None,
            None,
            None,
            "denied",
        );
        let denied_state = git_state(vec![preexisting.clone(), allowed_entry, denied_entry]);
        let failed = execute_diff_scope_gate(
            Path::new("unused-for-equal-head"),
            &baseline,
            &denied_state,
            &["src/**".to_owned()],
            &["src/generated/**".to_owned()],
            &AtomicBool::new(false),
        );
        assert_eq!(failed.outcome, VerificationGateOutcome::Failed);
        assert_eq!(
            failed.evidence.violating_paths,
            vec!["src/generated/code.rs"]
        );

        let cleanliness =
            execute_cleanliness_gate(&denied_state, true, false, true, &AtomicBool::new(false));
        assert_eq!(cleanliness.outcome, VerificationGateOutcome::Failed);
        assert_eq!(
            cleanliness.evidence.violating_unstaged_paths,
            vec!["preexisting.txt"]
        );
    }

    #[test]
    fn rename_requires_both_source_and_destination_to_be_in_scope() {
        let baseline = git_state(Vec::new());
        let renamed = status_entry(
            GitStatusKind::RenameOrCopy,
            "src/new.rs",
            Some("docs/old.rs"),
            Some('R'),
            Some('.'),
            "renamed",
        );
        let final_state = git_state(vec![renamed]);
        let execution = execute_diff_scope_gate(
            Path::new("unused-for-equal-head"),
            &baseline,
            &final_state,
            &["src/**".to_owned()],
            &[],
            &AtomicBool::new(false),
        );
        assert_eq!(execution.outcome, VerificationGateOutcome::Failed);
        assert_eq!(
            execution.evidence.changed_paths,
            vec!["docs/old.rs", "src/new.rs"]
        );
        assert_eq!(execution.evidence.violating_paths, vec!["docs/old.rs"]);

        let cancelled =
            execute_cleanliness_gate(&final_state, true, true, true, &AtomicBool::new(true));
        assert_eq!(cancelled.outcome, VerificationGateOutcome::Cancelled);
    }

    #[test]
    fn executable_resolution_uses_safe_path_and_confines_relative_paths() {
        let base = std::env::temp_dir().join(format!(
            "xiao-executable-resolution-{}",
            crate::runs::repository::new_uuid_v7()
        ));
        let root = base.join("workspace");
        let tools = root.join("tools");
        let external_bin = base.join("external-bin");
        let outside = base.join("outside");
        fs::create_dir_all(&tools).unwrap();
        fs::create_dir_all(&external_bin).unwrap();
        fs::create_dir_all(&outside).unwrap();

        let file_name = if cfg!(windows) {
            "xiao-resolver.EXE"
        } else {
            "xiao-resolver"
        };
        let source = std::env::current_exe().unwrap();
        let shadow = root.join(file_name);
        let external = external_bin.join(file_name);
        let relative = tools.join(file_name);
        let escaped = outside.join(file_name);
        for target in [&shadow, &external, &relative, &escaped] {
            fs::copy(&source, target).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt as _;

                let mut permissions = fs::metadata(target).unwrap().permissions();
                permissions.set_mode(0o755);
                fs::set_permissions(target, permissions).unwrap();
            }
        }

        let path = std::env::join_paths([&root, &external_bin]).unwrap();
        let bare = resolve_command_executable_with_environment(
            &root,
            "xiao-resolver",
            Some(&path),
            Some(OsStr::new(".EXE")),
        )
        .unwrap();
        assert_eq!(bare, fs::canonicalize(&external).unwrap());

        let relative_name = Path::new("tools").join(file_name);
        assert_eq!(
            resolve_command_executable_with_environment(
                &root,
                &relative_name.to_string_lossy(),
                None,
                None,
            )
            .unwrap(),
            fs::canonicalize(&relative).unwrap()
        );
        let escaped_name = Path::new("..").join("outside").join(file_name);
        assert!(resolve_command_executable_with_environment(
            &root,
            &escaped_name.to_string_lossy(),
            None,
            None,
        )
        .is_err());
        assert_eq!(
            resolve_command_executable_with_environment(
                &root,
                &display_path(&external),
                None,
                None,
            )
            .unwrap(),
            fs::canonicalize(&external).unwrap()
        );
        assert!(resolve_command_executable_with_environment(
            &root,
            "xiao-resolver",
            Some(OsStr::new("relative-bin")),
            Some(OsStr::new(".EXE")),
        )
        .is_err());

        let linked_bin = root.join("linked-bin");
        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_dir(&external_bin, &linked_bin);
        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(&external_bin, &linked_bin);
        if linked.is_ok() {
            let linked_path = std::env::join_paths([&linked_bin]).unwrap();
            assert!(resolve_command_executable_with_environment(
                &root,
                "xiao-resolver",
                Some(&linked_path),
                Some(OsStr::new(".EXE")),
            )
            .is_err());
        }

        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn native_command_pass_failure_and_expected_multi_exit_are_distinct() {
        let root = std::env::current_dir().unwrap();
        let executable = std::env::current_exe().unwrap();
        let cancellation = AtomicBool::new(false);
        let passed = execute_command_gate_with_supervision(
            &root,
            &display_path(&executable),
            &fixture_arguments("fixture_output"),
            5_000,
            &[0],
            &cancellation,
            false,
        );
        assert_eq!(passed.outcome, VerificationGateOutcome::Passed);
        assert_eq!(passed.exit_code, Some(0));
        assert!(passed.evidence.output_head.contains("fixture-stdout"));
        assert!(passed.evidence.output_head.contains("fixture-stderr"));

        let failed = execute_command_gate_with_supervision(
            &root,
            &display_path(&executable),
            &fixture_arguments("fixture_exit_seven"),
            5_000,
            &[0],
            &cancellation,
            false,
        );
        assert_eq!(failed.outcome, VerificationGateOutcome::Failed);
        assert_eq!(failed.exit_code, Some(7));

        let accepted = execute_command_gate_with_supervision(
            &root,
            &display_path(&executable),
            &fixture_arguments("fixture_exit_seven"),
            5_000,
            &[0, 7],
            &cancellation,
            false,
        );
        assert_eq!(accepted.outcome, VerificationGateOutcome::Passed);
        assert_eq!(accepted.exit_code, Some(7));
    }

    #[test]
    fn missing_timeout_and_cancellation_are_blocked_or_cancelled() {
        let root = std::env::current_dir().unwrap();
        let cancellation = Arc::new(AtomicBool::new(false));
        let missing = execute_command_gate_with_supervision(
            &root,
            "xiao-command-that-does-not-exist",
            &[],
            1_000,
            &[0],
            &cancellation,
            false,
        );
        assert_eq!(missing.outcome, VerificationGateOutcome::Blocked);

        let executable = std::env::current_exe().unwrap();
        let timed_out = execute_command_gate_with_supervision(
            &root,
            &display_path(&executable),
            &fixture_arguments("fixture_sleep"),
            100,
            &[0],
            &cancellation,
            false,
        );
        assert_eq!(timed_out.outcome, VerificationGateOutcome::Blocked);
        assert!(timed_out
            .diagnostic
            .as_deref()
            .is_some_and(|diagnostic| diagnostic.contains("timed out")));

        let worker_cancellation = Arc::clone(&cancellation);
        let worker_root = root.clone();
        let worker_executable = display_path(&executable);
        let worker = thread::spawn(move || {
            execute_command_gate_with_supervision(
                &worker_root,
                &worker_executable,
                &fixture_arguments("fixture_sleep"),
                5_000,
                &[0],
                &worker_cancellation,
                false,
            )
        });
        thread::sleep(Duration::from_millis(100));
        cancellation.store(true, Ordering::Release);
        let cancelled = worker.join().unwrap();
        assert_eq!(cancelled.outcome, VerificationGateOutcome::Cancelled);
    }

    #[test]
    fn output_is_bounded_hashed_and_cwd_is_exact() {
        let directory = std::env::temp_dir().join(format!(
            "xiao-command-cwd-{}-{}",
            std::process::id(),
            crate::runs::repository::new_uuid_v7()
        ));
        fs::create_dir_all(&directory).unwrap();
        let executable = std::env::current_exe().unwrap();
        let cancellation = AtomicBool::new(false);
        let execution = execute_command_gate_with_supervision(
            &directory,
            &display_path(&executable),
            &fixture_arguments("fixture_large_output_and_cwd"),
            5_000,
            &[0],
            &cancellation,
            false,
        );
        let _ = fs::remove_dir_all(&directory);

        assert_eq!(execution.outcome, VerificationGateOutcome::Passed);
        assert!(execution.evidence.total_output_bytes > 512 * 1024);
        assert!(execution.evidence.output_truncated);
        assert_eq!(execution.evidence.output_sha256.len(), 64);
        assert!(execution
            .evidence
            .output_tail
            .contains("fixture-output-end"));
        assert!(execution.evidence.output_head.contains(&display_path(
            &fs::canonicalize(&directory).unwrap_or(directory)
        )));
    }

    #[test]
    fn shell_metacharacters_are_literal_arguments() {
        let root = std::env::current_dir().unwrap();
        let side_effect = std::env::temp_dir().join(format!(
            "xiao-command-side-effect-{}",
            crate::runs::repository::new_uuid_v7()
        ));
        let malicious = format!("& echo injected > {}", side_effect.display());
        let mut arguments = fixture_arguments("fixture_output");
        arguments.push("--skip".to_owned());
        arguments.push(malicious);
        let execution = execute_command_gate_with_supervision(
            &root,
            &display_path(&std::env::current_exe().unwrap()),
            &arguments,
            5_000,
            &[0],
            &AtomicBool::new(false),
            false,
        );
        assert_eq!(execution.outcome, VerificationGateOutcome::Passed);
        assert!(!side_effect.exists());
    }

    #[test]
    #[ignore]
    fn fixture_output() {
        println!("fixture-stdout");
        eprintln!("fixture-stderr");
    }

    #[test]
    #[ignore]
    fn fixture_exit_seven() {
        std::process::exit(7);
    }

    #[test]
    #[ignore]
    fn fixture_sleep() {
        thread::sleep(Duration::from_secs(10));
    }

    #[test]
    #[ignore]
    fn fixture_large_output_and_cwd() {
        println!("{}", display_path(&std::env::current_dir().unwrap()));
        let bytes = vec![b'x'; 600 * 1024];
        std::io::stdout().write_all(&bytes).unwrap();
        eprintln!("fixture-output-end");
    }
}
