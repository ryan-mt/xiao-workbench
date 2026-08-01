use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::thread;

#[cfg(windows)]
use std::os::windows::io::{AsRawHandle, BorrowedHandle, OwnedHandle};

#[cfg(not(windows))]
use portable_pty::ChildKiller;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
#[cfg(windows)]
use windows_sys::Win32::System::Threading::TerminateProcess;

const MIN_COLS: u16 = 20;
const MIN_ROWS: u16 = 4;
const MAX_REPLAY_BYTES: usize = 256 * 1024;

#[cfg(windows)]
type TerminalKiller = OwnedHandle;
#[cfg(not(windows))]
type TerminalKiller = Box<dyn ChildKiller + Send + Sync>;

struct TerminalSession {
    project_path: String,
    task_id: Option<String>,
    workspace_path: PathBuf,
    shell: String,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<TerminalKiller>,
    output: Mutex<TerminalReplay>,
}

struct SessionStore<T> {
    entries: Mutex<HashMap<String, Arc<T>>>,
}

enum SessionClaim<T, R> {
    Existing(Arc<T>),
    Inserted { session: Arc<T>, resources: R },
}

impl<T> Default for SessionStore<T> {
    fn default() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
        }
    }
}

impl<T> SessionStore<T> {
    #[cfg(test)]
    fn is_current(&self, session_id: &str, session: &Arc<T>) -> bool {
        self.entries
            .lock()
            .ok()
            .and_then(|entries| {
                entries
                    .get(session_id)
                    .map(|current| Arc::ptr_eq(current, session))
            })
            .unwrap_or(false)
    }

    fn get_or_try_insert_with<R>(
        &self,
        session_id: String,
        validate_existing: impl FnOnce(&T) -> Result<(), String>,
        create: impl FnOnce() -> Result<(T, R), String>,
    ) -> Result<SessionClaim<T, R>, String> {
        let mut entries = self.entries.lock().map_err(|error| error.to_string())?;
        if let Some(existing) = entries.get(&session_id) {
            validate_existing(existing)?;
            return Ok(SessionClaim::Existing(Arc::clone(existing)));
        }

        let (session, resources) = create()?;
        let session = Arc::new(session);
        entries.insert(session_id, Arc::clone(&session));
        Ok(SessionClaim::Inserted { session, resources })
    }

    fn update_and_emit_if_current<R>(
        &self,
        session_id: &str,
        session: &Arc<T>,
        update: impl FnOnce(&T) -> R,
        emit: impl FnOnce(R),
    ) -> bool {
        let Ok(entries) = self.entries.lock() else {
            return false;
        };
        let Some(current) = entries.get(session_id) else {
            return false;
        };
        if !Arc::ptr_eq(current, session) {
            return false;
        }
        let event = update(current);
        emit(event);
        true
    }

    fn finish(&self, session_id: &str, session: &Arc<T>) -> bool {
        let Ok(mut entries) = self.entries.lock() else {
            return true;
        };
        match entries.get(session_id) {
            Some(current) if Arc::ptr_eq(current, session) => {
                entries.remove(session_id);
                true
            }
            Some(_) => false,
            None => true,
        }
    }
}

fn retire_after_output<T, R>(
    sessions: &SessionStore<T>,
    session_id: &str,
    session: &Arc<T>,
    exit_result: Receiver<R>,
    disconnected: impl FnOnce(String) -> R,
    emit: impl FnOnce(R),
) {
    let result = exit_result
        .recv()
        .unwrap_or_else(|error| disconnected(error.to_string()));
    if sessions.finish(session_id, session) {
        emit(result);
    }
}

#[derive(Default)]
struct TerminalReplay {
    data: String,
    sequence: u64,
}

#[derive(Default)]
pub struct TerminalManager {
    sessions: Arc<SessionStore<TerminalSession>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalStartResult {
    pub session_id: String,
    pub shell: String,
    pub replay: String,
    pub replay_sequence: u64,
}

pub(super) struct TerminalStartRequest {
    pub(super) session_id: String,
    pub(super) project_path: String,
    pub(super) task_id: Option<String>,
    pub(super) workspace_path: String,
    pub(super) shell: String,
    pub(super) cols: u16,
    pub(super) rows: u16,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalOutput {
    session_id: String,
    data: String,
    sequence: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalExit {
    session_id: String,
    exit_code: Option<u32>,
    error: Option<String>,
}

#[derive(Default)]
struct Utf8StreamDecoder {
    pending: Vec<u8>,
}

impl Utf8StreamDecoder {
    fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        self.decode(false)
    }

    fn finish(&mut self) -> String {
        self.decode(true)
    }

    fn decode(&mut self, finish: bool) -> String {
        let bytes = std::mem::take(&mut self.pending);
        let mut remaining = bytes.as_slice();
        let mut output = String::new();
        loop {
            match std::str::from_utf8(remaining) {
                Ok(text) => {
                    output.push_str(text);
                    break;
                }
                Err(error) => {
                    let valid = error.valid_up_to();
                    output.push_str(std::str::from_utf8(&remaining[..valid]).unwrap_or_default());
                    remaining = &remaining[valid..];
                    match error.error_len() {
                        Some(length) => {
                            output.push('\u{FFFD}');
                            remaining = &remaining[length..];
                            if remaining.is_empty() {
                                break;
                            }
                        }
                        None => {
                            if finish {
                                output.push('\u{FFFD}');
                            } else {
                                self.pending.extend_from_slice(remaining);
                            }
                            break;
                        }
                    }
                }
            }
        }
        output
    }
}

impl TerminalManager {
    pub(super) fn start(
        &self,
        app: AppHandle,
        request: TerminalStartRequest,
    ) -> Result<TerminalStartResult, String> {
        let TerminalStartRequest {
            session_id,
            project_path,
            task_id,
            workspace_path,
            shell,
            cols,
            rows,
        } = request;
        validate_session_id(&session_id)?;
        let workspace = Path::new(&workspace_path)
            .canonicalize()
            .map_err(|error| error.to_string())?;
        if !workspace.is_dir() {
            return Err("The terminal workspace is not a directory.".to_owned());
        }
        let shell = shell.trim();
        if shell.is_empty() || shell == "Unknown shell" {
            return Err("No system shell is available.".to_owned());
        }
        let expected_project_path = project_path.clone();
        let expected_task_id = task_id.clone();
        let expected_workspace = workspace.clone();
        let claim = self.sessions.get_or_try_insert_with(
            session_id.clone(),
            move |existing| {
                validate_session_execution(
                    existing,
                    &expected_project_path,
                    expected_task_id.as_deref(),
                    &expected_workspace,
                )
            },
            move || {
                let pair = native_pty_system()
                    .openpty(pty_size(cols, rows))
                    .map_err(|error| error.to_string())?;
                let mut command = CommandBuilder::new(shell);
                command.cwd(&workspace);
                command.env("TERM", "xterm-256color");
                command.env("COLORTERM", "truecolor");
                let child = pair
                    .slave
                    .spawn_command(command)
                    .map_err(|error| error.to_string())?;
                drop(pair.slave);

                let reader = pair
                    .master
                    .try_clone_reader()
                    .map_err(|error| error.to_string())?;
                let writer = pair
                    .master
                    .take_writer()
                    .map_err(|error| error.to_string())?;
                let killer = clone_terminal_killer(child.as_ref())?;
                Ok((
                    TerminalSession {
                        project_path,
                        task_id,
                        workspace_path: workspace,
                        shell: shell.to_owned(),
                        master: Mutex::new(pair.master),
                        writer: Mutex::new(writer),
                        killer: Mutex::new(killer),
                        output: Mutex::new(TerminalReplay::default()),
                    },
                    (reader, child),
                ))
            },
        )?;
        let (session, mut reader, mut child) = match claim {
            SessionClaim::Existing(existing) => {
                let replay = existing.output.lock().map_err(|error| error.to_string())?;
                return Ok(TerminalStartResult {
                    session_id,
                    shell: existing.shell.clone(),
                    replay: replay.data.clone(),
                    replay_sequence: replay.sequence,
                });
            }
            SessionClaim::Inserted {
                session,
                resources: (reader, child),
            } => (session, reader, child),
        };

        let output_app = app.clone();
        let output_session_id = session_id.clone();
        let output_session = Arc::clone(&session);
        let output_sessions = Arc::clone(&self.sessions);
        let (exit_tx, exit_rx) = mpsc::channel();
        thread::spawn(move || {
            let mut buffer = [0_u8; 8192];
            let mut decoder = Utf8StreamDecoder::default();
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(read) => {
                        let data = decoder.push(&buffer[..read]);
                        if data.is_empty() {
                            continue;
                        }
                        output_sessions.update_and_emit_if_current(
                            &output_session_id,
                            &output_session,
                            |session| TerminalOutput {
                                session_id: output_session_id.clone(),
                                sequence: record_terminal_output(&session.output, &data),
                                data,
                            },
                            |output| {
                                let _ = output_app.emit("terminal://output", output);
                            },
                        );
                    }
                    Err(_) => break,
                }
            }
            let data = decoder.finish();
            if !data.is_empty() {
                output_sessions.update_and_emit_if_current(
                    &output_session_id,
                    &output_session,
                    |session| TerminalOutput {
                        session_id: output_session_id.clone(),
                        sequence: record_terminal_output(&session.output, &data),
                        data,
                    },
                    |output| {
                        let _ = output_app.emit("terminal://output", output);
                    },
                );
            }

            retire_after_output(
                &output_sessions,
                &output_session_id,
                &output_session,
                exit_rx,
                |error| (None, Some(error)),
                |(exit_code, error)| {
                    let _ = output_app.emit(
                        "terminal://exit",
                        TerminalExit {
                            session_id: output_session_id.clone(),
                            exit_code,
                            error,
                        },
                    );
                },
            );
        });

        thread::spawn(move || {
            let result = match child.wait() {
                Ok(status) => (Some(status.exit_code()), None),
                Err(error) => (None, Some(error.to_string())),
            };
            let _ = exit_tx.send(result);
        });

        Ok(TerminalStartResult {
            session_id,
            shell: shell.to_owned(),
            replay: String::new(),
            replay_sequence: 0,
        })
    }

    pub fn write(&self, session_id: &str, data: &str) -> Result<(), String> {
        let session = self.session(session_id)?;
        let mut writer = session.writer.lock().map_err(|error| error.to_string())?;
        writer
            .write_all(data.as_bytes())
            .and_then(|_| writer.flush())
            .map_err(|error| error.to_string())
    }

    pub fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let session = self.session(session_id)?;
        let result = session
            .master
            .lock()
            .map_err(|error| error.to_string())?
            .resize(pty_size(cols, rows))
            .map_err(|error| error.to_string());
        result
    }

    pub(crate) fn stop_for_execution_change(
        &self,
        project_path: &str,
        task_id: &str,
    ) -> Result<(), String> {
        let session_ids = self
            .sessions
            .entries
            .lock()
            .map_err(|error| error.to_string())?
            .iter()
            .filter(|(_, session)| {
                session.project_path == project_path
                    && session.task_id.as_deref().is_none_or(|id| id == task_id)
            })
            .map(|(session_id, _)| session_id.clone())
            .collect::<Vec<_>>();
        for session_id in session_ids {
            self.stop(&session_id)?;
        }
        Ok(())
    }

    pub fn stop(&self, session_id: &str) -> Result<(), String> {
        let session = self
            .sessions
            .entries
            .lock()
            .map_err(|error| error.to_string())?
            .remove(session_id);
        if let Some(session) = session {
            let mut killer = session.killer.lock().map_err(|error| error.to_string())?;
            kill_terminal(&mut killer)?;
        }
        Ok(())
    }

    fn session(&self, session_id: &str) -> Result<Arc<TerminalSession>, String> {
        self.sessions
            .entries
            .lock()
            .map_err(|error| error.to_string())?
            .get(session_id)
            .cloned()
            .ok_or_else(|| "The terminal session is no longer running.".to_owned())
    }
}

fn validate_session_execution(
    session: &TerminalSession,
    project_path: &str,
    task_id: Option<&str>,
    workspace_path: &Path,
) -> Result<(), String> {
    if !same_execution(
        &session.project_path,
        session.task_id.as_deref(),
        &session.workspace_path,
        project_path,
        task_id,
        workspace_path,
    ) {
        return Err("This terminal session belongs to a different Task execution.".to_owned());
    }
    Ok(())
}

fn same_execution(
    existing_project_path: &str,
    existing_task_id: Option<&str>,
    existing_workspace_path: &Path,
    project_path: &str,
    task_id: Option<&str>,
    workspace_path: &Path,
) -> bool {
    existing_project_path == project_path
        && existing_task_id == task_id
        && existing_workspace_path == workspace_path
}

fn record_terminal_output(output: &Mutex<TerminalReplay>, data: &str) -> u64 {
    let Ok(mut replay) = output.lock() else {
        return 0;
    };
    replay.sequence = replay.sequence.saturating_add(1);
    replay.data.push_str(data);
    if replay.data.len() > MAX_REPLAY_BYTES {
        let mut keep_from = replay.data.len() - MAX_REPLAY_BYTES;
        while !replay.data.is_char_boundary(keep_from) {
            keep_from += 1;
        }
        replay.data.drain(..keep_from);
    }
    replay.sequence
}

impl Drop for TerminalManager {
    fn drop(&mut self) {
        if let Ok(mut sessions) = self.sessions.entries.lock() {
            for (_, session) in sessions.drain() {
                if let Ok(mut killer) = session.killer.lock() {
                    let _ = kill_terminal(&mut killer);
                }
            }
        }
    }
}

#[cfg(windows)]
fn clone_terminal_killer(child: &dyn portable_pty::Child) -> Result<TerminalKiller, String> {
    let handle = child
        .as_raw_handle()
        .ok_or_else(|| "The terminal process handle is unavailable.".to_owned())?;
    unsafe { BorrowedHandle::borrow_raw(handle) }
        .try_clone_to_owned()
        .map_err(|error| error.to_string())
}

#[cfg(not(windows))]
fn clone_terminal_killer(child: &dyn portable_pty::Child) -> Result<TerminalKiller, String> {
    Ok(child.clone_killer())
}

#[cfg(windows)]
fn kill_terminal(killer: &mut TerminalKiller) -> Result<(), String> {
    if unsafe { TerminateProcess(killer.as_raw_handle(), 1) } == 0 {
        Err(std::io::Error::last_os_error().to_string())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn kill_terminal(killer: &mut TerminalKiller) -> Result<(), String> {
    killer.kill().map_err(|error| error.to_string())
}

fn pty_size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        cols: cols.max(MIN_COLS),
        rows: rows.max(MIN_ROWS),
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn validate_session_id(session_id: &str) -> Result<(), String> {
    if session_id.len() > 64
        || session_id.is_empty()
        || !session_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
    {
        return Err("Invalid terminal session id.".to_owned());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Barrier;
    use std::time::Duration;

    #[test]
    fn terminal_sizes_have_safe_minimums() {
        let size = pty_size(0, 0);
        assert_eq!(size.cols, MIN_COLS);
        assert_eq!(size.rows, MIN_ROWS);
    }

    #[test]
    fn terminal_session_ids_are_restricted() {
        assert!(validate_session_id("terminal-123").is_ok());
        assert!(validate_session_id("../terminal").is_err());
    }

    #[test]
    fn session_id_cannot_be_reused_for_a_different_execution_root() {
        assert!(same_execution(
            "project",
            Some("task"),
            Path::new("first-worktree"),
            "project",
            Some("task"),
            Path::new("first-worktree"),
        ));
        assert!(!same_execution(
            "project",
            Some("task"),
            Path::new("first-worktree"),
            "project",
            Some("task"),
            Path::new("replacement-worktree"),
        ));
    }

    #[test]
    fn concurrent_claims_create_only_one_session_for_an_id() {
        let store = Arc::new(SessionStore::<usize>::default());
        let barrier = Arc::new(Barrier::new(8));
        let creations = Arc::new(AtomicUsize::new(0));
        let threads = (0..8)
            .map(|_| {
                let store = Arc::clone(&store);
                let barrier = Arc::clone(&barrier);
                let creations = Arc::clone(&creations);
                thread::spawn(move || {
                    barrier.wait();
                    match store
                        .get_or_try_insert_with(
                            "shared".to_owned(),
                            |_| Ok(()),
                            || {
                                creations.fetch_add(1, Ordering::SeqCst);
                                thread::sleep(Duration::from_millis(20));
                                Ok((42, ()))
                            },
                        )
                        .unwrap()
                    {
                        SessionClaim::Existing(session) => session,
                        SessionClaim::Inserted { session, .. } => session,
                    }
                })
            })
            .collect::<Vec<_>>();
        let sessions = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect::<Vec<_>>();

        assert_eq!(creations.load(Ordering::SeqCst), 1);
        assert!(sessions
            .iter()
            .all(|session| Arc::ptr_eq(session, &sessions[0])));
    }

    #[test]
    fn stale_waiter_does_not_remove_or_finish_replacement_session() {
        let store = SessionStore::<usize>::default();
        let old = match store
            .get_or_try_insert_with("shared".to_owned(), |_| Ok(()), || Ok((1, ())))
            .unwrap()
        {
            SessionClaim::Inserted { session, .. } => session,
            SessionClaim::Existing(_) => unreachable!(),
        };
        store.entries.lock().unwrap().remove("shared");
        let replacement = match store
            .get_or_try_insert_with("shared".to_owned(), |_| Ok(()), || Ok((2, ())))
            .unwrap()
        {
            SessionClaim::Inserted { session, .. } => session,
            SessionClaim::Existing(_) => unreachable!(),
        };

        assert!(!store.finish("shared", &old));
        let current = store
            .entries
            .lock()
            .unwrap()
            .get("shared")
            .cloned()
            .unwrap();
        assert!(Arc::ptr_eq(&current, &replacement));
    }

    #[test]
    fn child_exit_waits_for_final_output_before_retiring_session() {
        let store = Arc::new(SessionStore::<Mutex<String>>::default());
        let session = match store
            .get_or_try_insert_with(
                "shared".to_owned(),
                |_| Ok(()),
                || Ok((Mutex::new(String::new()), ())),
            )
            .unwrap()
        {
            SessionClaim::Inserted { session, .. } => session,
            SessionClaim::Existing(_) => unreachable!(),
        };
        let child_exited = Arc::new(Barrier::new(3));
        let final_read_allowed = Arc::new(Barrier::new(2));
        let events = Arc::new(Mutex::new(Vec::new()));
        let (exit_tx, exit_rx) = mpsc::channel::<Result<u32, String>>();

        let waiter = {
            let child_exited = Arc::clone(&child_exited);
            thread::spawn(move || {
                exit_tx.send(Ok(7)).unwrap();
                child_exited.wait();
            })
        };
        let reader = {
            let store = Arc::clone(&store);
            let session = Arc::clone(&session);
            let child_exited = Arc::clone(&child_exited);
            let final_read_allowed = Arc::clone(&final_read_allowed);
            let events = Arc::clone(&events);
            thread::spawn(move || {
                child_exited.wait();
                final_read_allowed.wait();
                store.update_and_emit_if_current(
                    "shared",
                    &session,
                    |output| output.lock().unwrap().push_str("final output"),
                    |_| events.lock().unwrap().push("output"),
                );
                retire_after_output(&store, "shared", &session, exit_rx, Err, |result| {
                    assert_eq!(result, Ok(7));
                    events.lock().unwrap().push("exit");
                });
            })
        };

        child_exited.wait();
        assert!(store.is_current("shared", &session));
        assert!(events.lock().unwrap().is_empty());
        final_read_allowed.wait();
        waiter.join().unwrap();
        reader.join().unwrap();

        assert_eq!(*session.lock().unwrap(), "final output");
        assert_eq!(*events.lock().unwrap(), ["output", "exit"]);
        assert!(!store.is_current("shared", &session));
    }

    #[test]
    fn stale_output_does_not_mutate_replay_or_emit_under_a_reused_session_id() {
        #[derive(Default)]
        struct OutputSession {
            replay: Mutex<String>,
        }

        let store = Arc::new(SessionStore::<OutputSession>::default());
        let old = match store
            .get_or_try_insert_with(
                "shared".to_owned(),
                |_| Ok(()),
                || Ok((OutputSession::default(), ())),
            )
            .unwrap()
        {
            SessionClaim::Inserted { session, .. } => session,
            SessionClaim::Existing(_) => unreachable!(),
        };

        let identity_checked = Arc::new(Barrier::new(2));
        let replacement_installed = Arc::new(Barrier::new(2));
        let stale_output = {
            let store = Arc::clone(&store);
            let old = Arc::clone(&old);
            let identity_checked = Arc::clone(&identity_checked);
            let replacement_installed = Arc::clone(&replacement_installed);
            thread::spawn(move || {
                assert!(store.is_current("shared", &old));
                identity_checked.wait();
                replacement_installed.wait();
                let emitted = store.update_and_emit_if_current(
                    "shared",
                    &old,
                    |session| session.replay.lock().unwrap().push_str("late output"),
                    |_| {},
                );
                usize::from(emitted)
            })
        };

        identity_checked.wait();
        store.entries.lock().unwrap().remove("shared");
        let replacement = match store
            .get_or_try_insert_with(
                "shared".to_owned(),
                |_| Ok(()),
                || Ok((OutputSession::default(), ())),
            )
            .unwrap()
        {
            SessionClaim::Inserted { session, .. } => session,
            SessionClaim::Existing(_) => unreachable!(),
        };
        replacement_installed.wait();
        let emitted = stale_output.join().unwrap();

        assert!(old.replay.lock().unwrap().is_empty());
        assert!(replacement.replay.lock().unwrap().is_empty());
        assert_eq!(emitted, 0);
    }

    #[test]
    fn replacement_cannot_install_between_output_update_and_emit() {
        let store = Arc::new(SessionStore::<Mutex<String>>::default());
        let old = match store
            .get_or_try_insert_with(
                "shared".to_owned(),
                |_| Ok(()),
                || Ok((Mutex::new(String::new()), ())),
            )
            .unwrap()
        {
            SessionClaim::Inserted { session, .. } => session,
            SessionClaim::Existing(_) => unreachable!(),
        };
        let payload_built = Arc::new(Barrier::new(2));
        let replacement_requested = Arc::new(Barrier::new(2));
        let replacement_installed = Arc::new(AtomicUsize::new(0));

        let replacement = {
            let store = Arc::clone(&store);
            let payload_built = Arc::clone(&payload_built);
            let replacement_requested = Arc::clone(&replacement_requested);
            let replacement_installed = Arc::clone(&replacement_installed);
            thread::spawn(move || {
                payload_built.wait();
                replacement_requested.wait();
                let mut entries = store.entries.lock().unwrap();
                entries.insert("shared".to_owned(), Arc::new(Mutex::new(String::new())));
                replacement_installed.store(1, Ordering::SeqCst);
            })
        };

        let emitted = Arc::new(Mutex::new(Vec::new()));
        assert!(store.update_and_emit_if_current(
            "shared",
            &old,
            |session| {
                session.lock().unwrap().push_str("output");
                payload_built.wait();
                replacement_requested.wait();
                session.lock().unwrap().clone()
            },
            {
                let emitted = Arc::clone(&emitted);
                let replacement_installed = Arc::clone(&replacement_installed);
                move |payload| {
                    assert_eq!(replacement_installed.load(Ordering::SeqCst), 0);
                    emitted.lock().unwrap().push(payload);
                }
            },
        ));
        replacement.join().unwrap();
        assert_eq!(replacement_installed.load(Ordering::SeqCst), 1);
        assert_eq!(*emitted.lock().unwrap(), ["output"]);
    }

    #[test]
    fn terminal_replay_is_bounded_and_keeps_monotonic_sequences() {
        let output = Mutex::new(TerminalReplay::default());
        assert_eq!(record_terminal_output(&output, "first"), 1);
        assert_eq!(
            record_terminal_output(&output, &"界".repeat(MAX_REPLAY_BYTES)),
            2
        );

        let replay = output.lock().unwrap();
        assert_eq!(replay.sequence, 2);
        assert!(replay.data.len() <= MAX_REPLAY_BYTES);
        assert!(std::str::from_utf8(replay.data.as_bytes()).is_ok());
        assert!(replay.data.ends_with('界'));
    }

    #[cfg(windows)]
    #[test]
    fn windows_terminal_killer_terminates_the_pty_process() {
        let pair = native_pty_system().openpty(PtySize::default()).unwrap();
        let mut command =
            CommandBuilder::new(std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_owned()));
        command.args(["/D", "/Q", "/K"]);
        let mut child = pair.slave.spawn_command(command).unwrap();
        let mut killer = clone_terminal_killer(child.as_ref()).unwrap();
        drop(pair.slave);

        kill_terminal(&mut killer).unwrap();

        assert_eq!(child.wait().unwrap().exit_code(), 1);
    }

    #[test]
    fn utf8_decoder_preserves_characters_split_across_chunks() {
        let expected = "ASCII \u{00b7} \u{03bb} \u{00b7} \u{6c49}\u{5b57} \u{00b7} \u{10348}";
        let mut decoder = Utf8StreamDecoder::default();
        let mut output = String::new();
        for byte in expected.as_bytes() {
            output.push_str(&decoder.push(std::slice::from_ref(byte)));
        }
        output.push_str(&decoder.finish());

        assert_eq!(output, expected);
        assert!(!output.contains('\u{FFFD}'));
    }

    #[test]
    fn native_pty_captures_shell_output() {
        let pair = native_pty_system().openpty(PtySize::default()).unwrap();
        #[cfg(windows)]
        let mut command = {
            let mut command = CommandBuilder::new(
                std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_owned()),
            );
            command.args(["/D", "/Q", "/C", "echo xiao-pty-ready"]);
            command
        };
        #[cfg(not(windows))]
        let mut command = {
            let mut command = CommandBuilder::new(
                std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_owned()),
            );
            command.args(["-lc", "printf xiao-pty-ready"]);
            command
        };
        command.cwd(std::env::temp_dir());
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut writer = pair.master.take_writer().unwrap();
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);
        #[cfg(windows)]
        writer.write_all(b"\x1b[1;1R").unwrap();
        drop(writer);
        let reader_thread = thread::spawn(move || {
            let mut output = String::new();
            reader.read_to_string(&mut output).unwrap();
            output
        });
        let status = child.wait();
        drop(pair.master);
        let output = reader_thread.join().unwrap();
        let status = status.unwrap();

        assert!(status.success());
        assert!(
            output.contains("xiao-pty-ready"),
            "PTY output was {output:?}"
        );
    }
}
