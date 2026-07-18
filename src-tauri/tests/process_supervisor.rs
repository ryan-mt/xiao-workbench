#![cfg(windows)]

use std::fs::{self, OpenOptions};
use std::io::Write as _;
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const FIXTURE_DIRECTORY_ENV: &str = "XIAO_PROCESS_FIXTURE_DIRECTORY";

struct ChildGuard(Child);

impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn killing_supervisor_terminates_the_complete_process_tree() {
    let fixture_directory = std::env::temp_dir().join(format!(
        "xiao-supervisor-tree-{}-{}",
        std::process::id(),
        unix_millis()
    ));
    fs::create_dir_all(&fixture_directory).unwrap();
    let heartbeat = fixture_directory.join("heartbeat");
    let test_executable = std::env::current_exe().unwrap();
    let supervisor_executable = env!("CARGO_BIN_EXE_xiao-workbench");
    let child = Command::new(supervisor_executable)
        .arg("--xiao-runtime-supervisor")
        .arg("wait-for-child")
        .arg(test_executable)
        .args([
            "--ignored",
            "--exact",
            "fixture_parent_spawns_descendant",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(FIXTURE_DIRECTORY_ENV, &fixture_directory)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut supervisor = ChildGuard(child);
    let supervisor_stdin = supervisor.0.stdin.take().unwrap();

    wait_until(Duration::from_secs(5), || {
        fs::metadata(&heartbeat).is_ok_and(|metadata| metadata.len() >= 3)
    });
    supervisor.0.kill().unwrap();
    supervisor.0.wait().unwrap();
    drop(supervisor_stdin);

    thread::sleep(Duration::from_millis(150));
    let settled_length = fs::metadata(&heartbeat).unwrap().len();
    thread::sleep(Duration::from_millis(350));
    assert_eq!(fs::metadata(&heartbeat).unwrap().len(), settled_length);
    fs::remove_dir_all(fixture_directory).unwrap();
}

#[test]
fn closing_parent_lifetime_pipe_terminates_the_complete_process_tree() {
    let fixture_directory = std::env::temp_dir().join(format!(
        "xiao-supervisor-lifetime-{}-{}",
        std::process::id(),
        unix_millis()
    ));
    fs::create_dir_all(&fixture_directory).unwrap();
    let heartbeat = fixture_directory.join("heartbeat");
    let test_executable = std::env::current_exe().unwrap();
    let supervisor_executable = env!("CARGO_BIN_EXE_xiao-workbench");
    let child = Command::new(supervisor_executable)
        .arg("--xiao-runtime-supervisor")
        .arg("wait-for-child")
        .arg(test_executable)
        .args([
            "--ignored",
            "--exact",
            "fixture_parent_spawns_descendant",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(FIXTURE_DIRECTORY_ENV, &fixture_directory)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut supervisor = ChildGuard(child);
    let supervisor_stdin = supervisor.0.stdin.take().unwrap();

    wait_until(Duration::from_secs(5), || {
        fs::metadata(&heartbeat).is_ok_and(|metadata| metadata.len() >= 3)
    });
    drop(supervisor_stdin);
    wait_until(Duration::from_secs(5), || {
        supervisor.0.try_wait().unwrap().is_some()
    });

    thread::sleep(Duration::from_millis(150));
    let settled_length = fs::metadata(&heartbeat).unwrap().len();
    thread::sleep(Duration::from_millis(350));
    assert_eq!(fs::metadata(&heartbeat).unwrap().len(), settled_length);
    fs::remove_dir_all(fixture_directory).unwrap();
}

#[test]
#[ignore]
fn fixture_parent_spawns_descendant() {
    let fixture_directory = std::env::var_os(FIXTURE_DIRECTORY_ENV).unwrap();
    let child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--ignored",
            "--exact",
            "fixture_descendant_heartbeat",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(FIXTURE_DIRECTORY_ENV, fixture_directory)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    std::mem::forget(child);
    loop {
        thread::sleep(Duration::from_secs(1));
    }
}

#[test]
#[ignore]
fn fixture_descendant_heartbeat() {
    let fixture_directory = std::env::var_os(FIXTURE_DIRECTORY_ENV).unwrap();
    let heartbeat = std::path::PathBuf::from(fixture_directory).join("heartbeat");
    let mut output = OpenOptions::new()
        .create(true)
        .append(true)
        .open(heartbeat)
        .unwrap();
    loop {
        output.write_all(b"x").unwrap();
        output.flush().unwrap();
        thread::sleep(Duration::from_millis(25));
    }
}

fn wait_until(timeout: Duration, mut condition: impl FnMut() -> bool) {
    let started = Instant::now();
    while !condition() {
        assert!(started.elapsed() < timeout, "process fixture timed out");
        thread::sleep(Duration::from_millis(25));
    }
}

fn unix_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis()
}
