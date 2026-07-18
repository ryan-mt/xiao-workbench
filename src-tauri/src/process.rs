use std::process::{Command, Stdio};

const RUNTIME_SUPERVISOR_FLAG: &str = "--xiao-runtime-supervisor";
const MONITOR_STDIN_MODE: &str = "monitor-stdin";
const WAIT_FOR_CHILD_MODE: &str = "wait-for-child";
#[cfg(windows)]
const FINITE_INPUT_MODE: &str = "finite-input";

pub fn run_if_requested() -> Option<i32> {
    #[cfg(windows)]
    {
        use std::ffi::OsStr;

        let mut arguments = std::env::args_os();
        let _executable = arguments.next();
        if arguments.next().as_deref() != Some(OsStr::new(RUNTIME_SUPERVISOR_FLAG)) {
            return None;
        }
        Some(match run_supervisor(arguments) {
            Ok(exit_code) => exit_code,
            Err(error) => {
                eprintln!("Xiao runtime supervisor failed: {error}");
                1
            }
        })
    }

    #[cfg(not(windows))]
    None
}

#[cfg(windows)]
pub(crate) fn supervise_command(command: Command) -> Result<Command, String> {
    supervise_command_with_mode(command, MONITOR_STDIN_MODE)
}

#[cfg(windows)]
pub(crate) fn supervise_process_tree(command: Command) -> Result<Command, String> {
    let mut supervised = supervise_command_with_mode(command, WAIT_FOR_CHILD_MODE)?;
    supervised.stdin(Stdio::piped());
    Ok(supervised)
}
#[cfg(windows)]
pub(crate) fn supervise_process_tree_with_input(command: Command) -> Result<Command, String> {
    let mut supervised = supervise_command_with_mode(command, FINITE_INPUT_MODE)?;
    supervised.stdin(Stdio::piped());
    Ok(supervised)
}

#[cfg(windows)]
fn supervise_command_with_mode(command: Command, mode: &str) -> Result<Command, String> {
    let program = command.get_program().to_os_string();
    let arguments = command
        .get_args()
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    let current_directory = command.get_current_dir().map(ToOwned::to_owned);
    let environment = command
        .get_envs()
        .map(|(key, value)| (key.to_os_string(), value.map(ToOwned::to_owned)))
        .collect::<Vec<_>>();

    let mut supervised = Command::new(std::env::current_exe().map_err(|error| error.to_string())?);
    supervised.arg(RUNTIME_SUPERVISOR_FLAG).arg(mode);
    if mode == FINITE_INPUT_MODE {
        supervised.arg(std::process::id().to_string());
    }
    supervised.arg(program).args(arguments);
    if let Some(current_directory) = current_directory {
        supervised.current_dir(current_directory);
    }
    for (key, value) in environment {
        match value {
            Some(value) => {
                supervised.env(key, value);
            }
            None => {
                supervised.env_remove(key);
            }
        }
    }
    Ok(supervised)
}

#[cfg(not(windows))]
pub(crate) fn supervise_command(command: Command) -> Result<Command, String> {
    Ok(command)
}
#[cfg(not(windows))]
pub(crate) fn supervise_process_tree(mut command: Command) -> Result<Command, String> {
    command.stdin(Stdio::null());
    Ok(command)
}
#[cfg(not(windows))]
pub(crate) fn supervise_process_tree_with_input(mut command: Command) -> Result<Command, String> {
    command.stdin(Stdio::piped());
    Ok(command)
}

#[cfg(windows)]
fn run_supervisor(mut arguments: impl Iterator<Item = std::ffi::OsString>) -> Result<i32, String> {
    use std::ffi::OsStr;
    use std::io;
    use std::os::windows::process::CommandExt as _;
    use std::process::Stdio;
    use std::thread;

    let mode = arguments
        .next()
        .ok_or("The process supervisor mode is missing.")?;
    let (forward_stdin, finite_input) = if mode == OsStr::new(MONITOR_STDIN_MODE) {
        (true, false)
    } else if mode == OsStr::new(WAIT_FOR_CHILD_MODE) {
        (false, false)
    } else if mode == OsStr::new(FINITE_INPUT_MODE) {
        (false, true)
    } else {
        return Err("The process supervisor mode is invalid.".to_owned());
    };
    let parent_pid = if finite_input {
        let raw_pid = arguments
            .next()
            .ok_or("The finite-input supervisor parent process is missing.")?;
        Some(
            raw_pid
                .to_string_lossy()
                .parse::<u32>()
                .map_err(|_| "The finite-input supervisor parent process is invalid.")?,
        )
    } else {
        None
    };
    let program = arguments
        .next()
        .ok_or("The process supervisor target is missing.")?;
    create_kill_on_close_job()?;
    if let Some(parent_pid) = parent_pid {
        monitor_parent_process(parent_pid)?;
    }

    let mut command = Command::new(program);
    command
        .args(arguments)
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
    if forward_stdin {
        command.stdin(Stdio::piped());
    } else if finite_input {
        command.stdin(Stdio::inherit());
    } else {
        command.stdin(Stdio::null());
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not start the supervised process: {error}"))?;

    if !finite_input {
        let child_stdin = if forward_stdin {
            Some(
                child
                    .stdin
                    .take()
                    .ok_or("The supervised process stdin is unavailable.")?,
            )
        } else {
            None
        };
        thread::Builder::new()
            .name("xiao-runtime-stdin".to_owned())
            .spawn(move || {
                let mut parent_stdin = io::stdin().lock();
                let copy_result = if let Some(mut child_stdin) = child_stdin {
                    io::copy(&mut parent_stdin, &mut child_stdin)
                } else {
                    io::copy(&mut parent_stdin, &mut io::sink())
                };
                let exit_code = if copy_result.is_ok() { 0 } else { 1 };
                // Parent EOF means the persistent runtime owner died. Exiting closes
                // the only job handle and terminates the complete process tree.
                std::process::exit(exit_code);
            })
            .map_err(|error| format!("Could not monitor the Xiao runtime pipe: {error}"))?;
    }

    let status = child
        .wait()
        .map_err(|error| format!("Could not wait for the supervised process: {error}"))?;
    Ok(status.code().unwrap_or(1))
}

#[cfg(windows)]
fn monitor_parent_process(parent_pid: u32) -> Result<(), String> {
    use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Threading::{OpenProcess, WaitForSingleObject, INFINITE};
    const PROCESS_SYNCHRONIZE_ACCESS: u32 = 0x0010_0000;

    let parent = unsafe { OpenProcess(PROCESS_SYNCHRONIZE_ACCESS, 0, parent_pid) };
    if parent.is_null() {
        return Err(format!(
            "Could not monitor the finite-input supervisor parent: {}",
            std::io::Error::last_os_error()
        ));
    }
    let parent = parent as usize;
    std::thread::Builder::new()
        .name("xiao-runtime-parent".to_owned())
        .spawn(move || {
            let parent = parent as windows_sys::Win32::Foundation::HANDLE;
            let wait_result = unsafe { WaitForSingleObject(parent, INFINITE) };
            unsafe {
                CloseHandle(parent);
            }
            // Exiting closes the sole job handle and terminates the target tree.
            std::process::exit(if wait_result == WAIT_OBJECT_0 { 0 } else { 1 });
        })
        .map(|_| ())
        .map_err(|error| format!("Could not monitor the finite-input supervisor parent: {error}"))
}

#[cfg(windows)]
fn create_kill_on_close_job() -> Result<(), String> {
    use std::ffi::c_void;
    use std::mem::{forget, size_of};
    use std::ptr::null;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::GetCurrentProcess;

    struct JobHandle(HANDLE);

    impl Drop for JobHandle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    let job = JobHandle(unsafe { CreateJobObjectW(null(), null()) });
    if job.0.is_null() {
        return Err(format!(
            "Could not create the runtime job: {}",
            std::io::Error::last_os_error()
        ));
    }

    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    let configured = unsafe {
        SetInformationJobObject(
            job.0,
            JobObjectExtendedLimitInformation,
            &limits as *const _ as *const c_void,
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    };
    if configured == 0 {
        return Err(format!(
            "Could not configure the runtime job: {}",
            std::io::Error::last_os_error()
        ));
    }

    if unsafe { AssignProcessToJobObject(job.0, GetCurrentProcess()) } == 0 {
        return Err(format!(
            "Could not join the runtime job: {}",
            std::io::Error::last_os_error()
        ));
    }

    // This process is the sole owner. The OS closes the handle on every exit path,
    // which applies KILL_ON_JOB_CLOSE to Codex and any descendants it spawned.
    forget(job);
    Ok(())
}

#[cfg(all(test, windows))]
mod tests {
    use std::ffi::OsStr;
    use std::io::Write as _;
    use std::path::PathBuf;
    use std::thread;
    use std::time::{Duration, Instant};

    use super::*;

    #[test]
    fn supervised_command_preserves_target_arguments_and_environment() {
        let mut target = Command::new("codex-test.exe");
        target
            .args(["app-server", "--stdio"])
            .env("XIAO_SUPERVISOR_TEST", "preserved");

        let supervised = supervise_command(target).unwrap();
        let arguments = supervised.get_args().collect::<Vec<_>>();

        assert_eq!(arguments[0], OsStr::new(RUNTIME_SUPERVISOR_FLAG));
        assert_eq!(arguments[1], OsStr::new(MONITOR_STDIN_MODE));
        assert_eq!(arguments[2], OsStr::new("codex-test.exe"));
        assert_eq!(arguments[3], OsStr::new("app-server"));
        assert_eq!(arguments[4], OsStr::new("--stdio"));
        assert!(supervised.get_envs().any(|(key, value)| {
            key == OsStr::new("XIAO_SUPERVISOR_TEST") && value == Some(OsStr::new("preserved"))
        }));
    }
    #[test]
    fn finite_input_command_selects_the_non_monitoring_supervisor_mode() {
        let supervised = supervise_process_tree_with_input(Command::new("git-test.exe")).unwrap();
        let arguments = supervised.get_args().collect::<Vec<_>>();

        assert_eq!(arguments[0], OsStr::new(RUNTIME_SUPERVISOR_FLAG));
        assert_eq!(arguments[1], OsStr::new(FINITE_INPUT_MODE));
        assert_eq!(arguments[2], OsStr::new(&std::process::id().to_string()));
        assert_eq!(arguments[3], OsStr::new("git-test.exe"));
    }

    fn helper_arguments(name: &str) -> [String; 4] {
        [
            "--ignored".to_owned(),
            "--exact".to_owned(),
            format!("process::tests::{name}"),
            "--nocapture".to_owned(),
        ]
    }

    fn run_supervisor_fixture(target: &str, mode: &str, input: &[u8]) -> std::process::Output {
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args(helper_arguments("runtime_supervisor_entry_helper"))
            .env("XIAO_TEST_SUPERVISOR_TARGET", target)
            .env("XIAO_TEST_SUPERVISOR_MODE", mode)
            .env(
                "XIAO_TEST_SUPERVISOR_PARENT_PID",
                std::process::id().to_string(),
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(input).unwrap();
        child.wait_with_output().unwrap()
    }

    #[test]
    #[ignore]
    fn runtime_supervisor_entry_helper() {
        let target = std::env::var("XIAO_TEST_SUPERVISOR_TARGET").unwrap();
        let mode = std::env::var("XIAO_TEST_SUPERVISOR_MODE").unwrap();
        let executable = std::env::current_exe().unwrap().into_os_string();
        let mut arguments = vec![mode.clone().into()];
        if mode == FINITE_INPUT_MODE {
            arguments.push(
                std::env::var("XIAO_TEST_SUPERVISOR_PARENT_PID")
                    .unwrap()
                    .into(),
            );
        }
        arguments.push(executable);
        arguments.extend(helper_arguments(&target).map(Into::into));
        let code = run_supervisor(arguments.into_iter()).unwrap_or(1);
        std::process::exit(code);
    }

    #[test]
    #[ignore]
    fn finite_supervisor_parent_helper() {
        let mut supervisor = Command::new(std::env::current_exe().unwrap())
            .args(helper_arguments("runtime_supervisor_entry_helper"))
            .env(
                "XIAO_TEST_SUPERVISOR_TARGET",
                "persistent_descendant_target_helper",
            )
            .env("XIAO_TEST_SUPERVISOR_MODE", FINITE_INPUT_MODE)
            .env(
                "XIAO_TEST_SUPERVISOR_PARENT_PID",
                std::process::id().to_string(),
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let ready = PathBuf::from(std::env::var_os("XIAO_TEST_READY").unwrap());
        let deadline = Instant::now() + Duration::from_secs(3);
        while !ready.exists() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        assert!(ready.exists(), "finite target did not start");
        // Keep the payload channel open: only this parent process exiting should
        // trigger the independent lifetime monitor.
        let _payload = supervisor.stdin.take().unwrap();
        std::process::exit(0);
    }

    #[test]
    #[ignore]
    fn finite_zero_target_helper() {
        let mut bytes = Vec::new();
        std::io::Read::read_to_end(&mut std::io::stdin(), &mut bytes).unwrap();
        thread::sleep(Duration::from_millis(75));
        assert_eq!(bytes, b"finite input");
    }

    #[test]
    #[ignore]
    fn finite_nonzero_target_helper() {
        let mut bytes = Vec::new();
        std::io::Read::read_to_end(&mut std::io::stdin(), &mut bytes).unwrap();
        thread::sleep(Duration::from_millis(75));
        std::process::exit(23);
    }

    #[test]
    #[ignore]
    fn hidden_console_target_helper() {
        #[link(name = "kernel32")]
        extern "system" {
            fn GetConsoleWindow() -> *mut std::ffi::c_void;
        }
        assert!(unsafe { GetConsoleWindow() }.is_null());
    }

    #[test]
    #[ignore]
    fn delayed_marker_helper() {
        thread::sleep(Duration::from_millis(750));
        std::fs::write(std::env::var_os("XIAO_TEST_MARKER").unwrap(), b"survived").unwrap();
    }

    #[test]
    #[ignore]
    fn persistent_descendant_target_helper() {
        let mut descendant = Command::new(std::env::current_exe().unwrap())
            .args(helper_arguments("delayed_marker_helper"))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        if let Some(ready) = std::env::var_os("XIAO_TEST_READY") {
            std::fs::write(ready, b"ready").unwrap();
        }
        thread::sleep(Duration::from_secs(10));
        descendant.wait().unwrap();
    }

    #[test]
    fn finite_input_supervision_returns_the_targets_real_status() {
        let success = run_supervisor_fixture(
            "finite_zero_target_helper",
            FINITE_INPUT_MODE,
            b"finite input",
        );
        assert_eq!(
            success.status.code(),
            Some(0),
            "{}",
            String::from_utf8_lossy(&success.stderr)
        );

        let failure = run_supervisor_fixture(
            "finite_nonzero_target_helper",
            FINITE_INPUT_MODE,
            b"finite input",
        );
        assert_eq!(failure.status.code(), Some(23));
    }

    #[test]
    fn supervised_target_is_created_without_a_console_window() {
        let output = run_supervisor_fixture("hidden_console_target_helper", FINITE_INPUT_MODE, b"");
        assert_eq!(
            output.status.code(),
            Some(0),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn monitor_stdin_eof_still_terminates_the_persistent_process_tree() {
        let marker = std::env::temp_dir().join(format!(
            "xiao-supervisor-marker-{}",
            crate::runs::repository::new_uuid_v7()
        ));
        let started = Instant::now();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args(helper_arguments("runtime_supervisor_entry_helper"))
            .env(
                "XIAO_TEST_SUPERVISOR_TARGET",
                "persistent_descendant_target_helper",
            )
            .env("XIAO_TEST_SUPERVISOR_MODE", MONITOR_STDIN_MODE)
            .env("XIAO_TEST_MARKER", &marker)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        drop(child.stdin.take());
        let output = child.wait_with_output().unwrap();
        assert_eq!(
            output.status.code(),
            Some(0),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(started.elapsed() < Duration::from_secs(3));
        thread::sleep(Duration::from_secs(1));
        assert!(!marker.exists());
    }

    #[test]
    fn forced_finite_supervisor_termination_kills_target_and_descendants() {
        let id = crate::runs::repository::new_uuid_v7();
        let marker = std::env::temp_dir().join(format!("xiao-supervisor-marker-{id}"));
        let ready = std::env::temp_dir().join(format!("xiao-supervisor-ready-{id}"));
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args(helper_arguments("runtime_supervisor_entry_helper"))
            .env(
                "XIAO_TEST_SUPERVISOR_TARGET",
                "persistent_descendant_target_helper",
            )
            .env("XIAO_TEST_SUPERVISOR_MODE", FINITE_INPUT_MODE)
            .env("XIAO_TEST_MARKER", &marker)
            .env(
                "XIAO_TEST_SUPERVISOR_PARENT_PID",
                std::process::id().to_string(),
            )
            .env("XIAO_TEST_READY", &ready)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        while !ready.exists() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        assert!(ready.exists(), "supervised target did not start");

        child.kill().unwrap();
        child.wait().unwrap();
        thread::sleep(Duration::from_secs(1));

        assert!(
            !marker.exists(),
            "a supervised descendant survived termination"
        );
        let _ = std::fs::remove_file(ready);
    }
    #[test]
    fn finite_supervisor_parent_exit_kills_target_and_descendants() {
        let id = crate::runs::repository::new_uuid_v7();
        let marker = std::env::temp_dir().join(format!("xiao-parent-marker-{id}"));
        let ready = std::env::temp_dir().join(format!("xiao-parent-ready-{id}"));
        let output = Command::new(std::env::current_exe().unwrap())
            .args(helper_arguments("finite_supervisor_parent_helper"))
            .env("XIAO_TEST_MARKER", &marker)
            .env("XIAO_TEST_READY", &ready)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .output()
            .unwrap();
        assert_eq!(
            output.status.code(),
            Some(0),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(ready.exists(), "finite target was not observed running");

        thread::sleep(Duration::from_secs(1));
        assert!(
            !marker.exists(),
            "finite target descendant survived its parent process"
        );
        let _ = std::fs::remove_file(ready);
    }
}
