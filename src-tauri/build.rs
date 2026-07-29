use std::fs;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

const APP_COMMANDS: &[&str] = &[
    "get_workspace_snapshot",
    "get_xiao_execution_context",
    "prepare_xiao_managed_worktree",
    "list_xiao_managed_worktrees",
    "remove_xiao_managed_worktree",
    "list_workspace_files",
    "read_workspace_file",
    "open_workspace_preview",
    "get_system_info",
    "check_codex_update",
    "update_codex_cli",
    "start_agent_runtime",
    "stop_agent_runtime",
    "agent_request",
    "read_codex_rollout_commands",
    "read_agent_account",
    "read_agent_rate_limits",
    "read_agent_usage",
    "list_agent_models",
    "enqueue_xiao_run",
    "steer_xiao_run",
    "list_xiao_runs",
    "list_xiao_pending_inputs",
    "load_xiao_run_events",
    "cancel_xiao_run",
    "retry_xiao_run",
    "resolve_xiao_run_input",
    "create_xiao_routine",
    "update_xiao_routine",
    "list_xiao_routines",
    "set_xiao_routine_enabled",
    "run_xiao_routine_now",
    "delete_xiao_routine",
    "save_xiao_task_acceptance_contract",
    "rerun_xiao_verification",
    "list_xiao_verification_evidence",
    "read_xiao_verification_artifact",
    "discover_xiao_acceptance_presets",
    "mutate_git",
    "get_git_branches",
    "compare_git_branch",
    "get_git_worktrees",
    "publish_git_branch",
    "get_git_pull_request",
    "create_git_draft_pull_request",
    "get_git_pull_request_checks",
    "add_git_worktree",
    "apply_git_patch",
    "create_git_checkpoint",
    "finish_git_checkpoint",
    "discard_git_checkpoint",
    "list_xiao_turn_checkpoints",
    "restore_xiao_turns",
    "export_xiao_handoff",
    "import_xiao_handoff",
    "start_terminal",
    "write_terminal",
    "resize_terminal",
    "stop_terminal",
    "navigate_browser",
    "open_external_url",
    "go_back_browser",
    "go_forward_browser",
    "reload_browser",
    "get_browser_url",
    "get_browser_console",
    "automate_task_preview",
    "capture_task_preview",
    "set_browser_muted",
    "issue_companion_pairing_bundle",
    "list_companion_sessions",
    "rotate_companion_session",
    "revoke_companion_session",
    "revoke_companion_device",
    "replace_companion_session_grants",
    "list_companion_audit",
    "pair_remote_companion",
    "poll_remote_companion",
    "confirm_remote_companion",
    "poll_remote_companion_notifications",
    "execute_remote_companion_command",
    "install_remote_companion_rotation",
    "forget_remote_companion",
    "load_xiao_workspace",
    "load_xiao_timeline_page",
    "search_xiao_history",
    "search_xiao_history_global",
    "save_xiao_workspace",
    "list_xiao_projects",
    "save_xiao_project_group",
    "list_xiao_project_groups",
    "reorder_xiao_project_groups",
    "delete_xiao_project_group",
    "update_xiao_project_presentation",
    "save_xiao_codex_profile",
    "list_xiao_codex_profiles",
    "delete_xiao_codex_profile",
    "bind_xiao_task_codex_profile",
    "transition_xiao_task_stage",
    "list_xiao_task_stage_transitions",
    "list_xiao_attention_items",
    "acknowledge_xiao_attention_item",
    "list_xiao_task_publications",
    "open_xiao_project",
];

#[cfg(not(test))]
fn main() {
    match validate_ticket03_certification() {
        Ok(certification) => {
            println!("cargo:rustc-env=XIAO_TICKET03_RELEASE_CERTIFIED={certification}");
        }
        Err(error) if allows_uncertified_build(std::env::var("PROFILE").as_deref().ok()) => {
            println!(
                "cargo:warning=Ticket 03 release certification is stale; \
                 continuing with an uncertified debug build: {error}"
            );
        }
        Err(error) => {
            panic!("Ticket 03 release certification does not match the verified source: {error}");
        }
    }
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(APP_COMMANDS)),
    )
    .expect("failed to build Xiao's Tauri manifest");
}

fn allows_uncertified_build(profile: Option<&str>) -> bool {
    profile == Some("debug")
}

fn validate_ticket03_certification() -> Result<String, String> {
    const ROW_IDS: &[&str] = &[
        "codex-runtime",
        "multiple-codex-accounts",
        "non-codex-providers",
        "projects-and-task-history",
        "task-lifecycle",
        "branches-and-worktrees",
        "task-timeline",
        "files-and-diffs",
        "in-app-editor",
        "terminals",
        "task-preview",
        "commands-and-keybindings",
        "checkpoints",
        "github-publication",
        "non-github-forges",
        "project-script-launcher",
        "operational-customization",
        "updates",
        "remote-execution-environments",
        "multi-device-access",
        "offline-and-reconnect",
        "scheduling",
        "acceptance-and-verification",
        "cross-project-supervision",
        "observatory",
        "task-handoff",
    ];
    const GATE_IDS: &[&str] = &[
        "companion-security",
        "companion-idempotency",
        "companion-reconnect-and-crash",
        "migration",
        "performance",
        "accessibility",
        "baseline-disposition",
        "typecheck-frontend-rust-production-build",
    ];

    let root = PathBuf::from(
        std::env::var("CARGO_MANIFEST_DIR")
            .map_err(|error| format!("Could not locate the Cargo manifest: {error}"))?,
    )
    .parent()
    .ok_or("The Cargo manifest has no workspace parent.")?
    .to_path_buf();
    let certification_path =
        root.join("src/features/release-assurance/ticket03-certification.json");
    println!("cargo:rerun-if-changed={}", certification_path.display());
    let bytes = fs::read(&certification_path)
        .map_err(|error| format!("Could not read Ticket 03 certification: {error}"))?;
    let document: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Could not decode Ticket 03 certification: {error}"))?;
    if document["status"] != "passed"
        || document["baselineCommit"] != "fda6486233e0b2f07ecfea166e1a94533cb923c4"
        || document["evidence"] != "src/features/release-assurance/ticket03-verification.md"
        || string_array(&document["rowIds"])? != ROW_IDS
        || string_array(&document["gateIds"])? != GATE_IDS
    {
        return Err("Ticket 03 certification metadata is incomplete or altered.".to_owned());
    }
    let expected = document["sourceFingerprint"]
        .as_str()
        .ok_or("Ticket 03 certification has no source fingerprint.")?;
    let actual = ticket03_source_fingerprint(&root)?;
    if expected != actual {
        return Err(format!(
            "Ticket 03 source fingerprint changed: certified {expected}, current {actual}"
        ));
    }
    let evidence_path = root.join(
        document["evidence"]
            .as_str()
            .ok_or("Ticket 03 certification has no evidence path.")?,
    );
    println!("cargo:rerun-if-changed={}", evidence_path.display());
    let evidence = fs::read_to_string(&evidence_path)
        .map_err(|error| format!("Could not read Ticket 03 verification evidence: {error}"))?;
    if !evidence.contains(&actual) {
        return Err(
            "Ticket 03 verification evidence is not bound to the certified source.".to_owned(),
        );
    }
    Ok(actual)
}

fn string_array<'a>(value: &'a serde_json::Value) -> Result<Vec<&'a str>, String> {
    value
        .as_array()
        .ok_or("Ticket 03 certification field is not an array.".to_owned())?
        .iter()
        .map(|item| {
            item.as_str()
                .ok_or("Ticket 03 certification array contains a non-string.".to_owned())
        })
        .collect()
}

fn ticket03_source_fingerprint(root: &Path) -> Result<String, String> {
    const SOURCES: &[&str] = &[
        "package.json",
        "package-lock.json",
        "tsconfig.app.json",
        "tsconfig.json",
        "tsconfig.node.json",
        "vite.config.ts",
        "src-tauri/build.rs",
        "src-tauri/Cargo.toml",
        "src-tauri/Cargo.lock",
        "src-tauri/permissions",
        "src-tauri/src/companion",
        "src-tauri/src/lib.rs",
        "src-tauri/src/runs",
        "src-tauri/src/verification",
        "src-tauri/src/xiao/models.rs",
        "src-tauri/src/xiao/repository.rs",
        "src-tauri/src/xiao/supervision.rs",
        "src-tauri/tauri.beta.conf.json",
        "src-tauri/tauri.conf.json",
        "src/app/App.tsx",
        "src/core/bridges/tauri.ts",
        "src/core/models/companion.ts",
        "src/features/companion",
        "src/features/release-assurance/releaseAssurance.ts",
        "src/features/release-assurance/releaseAssurance.test.ts",
        "src/features/shell/components/Sidebar.tsx",
        "src/features/shell/components/Sidebar.test.tsx",
        "src/features/shell/shell.types.ts",
    ];
    let mut files = Vec::new();
    for source in SOURCES {
        collect_source_files(&root.join(source), &mut files)?;
    }
    files.sort();
    let mut digest = Sha256::new();
    for path in files {
        println!("cargo:rerun-if-changed={}", path.display());
        let relative = path
            .strip_prefix(root)
            .map_err(|_| "A Ticket 03 source escaped the workspace root.".to_owned())?
            .to_string_lossy()
            .replace('\\', "/");
        digest.update(relative.as_bytes());
        digest.update([0]);
        let source = fs::read(&path)
            .map_err(|error| format!("Could not read Ticket 03 source {relative}: {error}"))?;
        digest.update(normalize_build_version(&relative, source));
        digest.update([0]);
    }
    Ok(format!("sha256:{}", hex_string(&digest.finalize())))
}

fn normalize_build_version(relative: &str, source: Vec<u8>) -> Vec<u8> {
    let mut text = match String::from_utf8(source) {
        Ok(text) => text,
        Err(error) => return error.into_bytes(),
    };
    text = text.replace("\r\n", "\n").replace('\r', "\n");
    const DAILY_PREFIX: &str = "0.0.0-day";
    let mut search_start = 0;
    while let Some(offset) = text[search_start..].find(DAILY_PREFIX) {
        let start = search_start + offset;
        let date_start = start + DAILY_PREFIX.len();
        let date_end = date_start + 8;
        if text
            .get(date_start..date_end)
            .is_some_and(|date| date.bytes().all(|byte| byte.is_ascii_digit()))
        {
            text.replace_range(date_start..date_end, "BUILD_DATE");
            search_start = date_start + "BUILD_DATE".len();
        } else {
            search_start = date_start;
        }
    }
    if matches!(
        relative,
        "src-tauri/tauri.conf.json" | "src-tauri/tauri.beta.conf.json"
    ) {
        text = text
            .lines()
            .map(|line| {
                if line.trim_start().starts_with("\"version\":") {
                    "  \"version\": \"BUILD_VERSION\","
                } else {
                    line
                }
            })
            .collect::<Vec<_>>()
            .join("\n");
    }
    text.into_bytes()
}

fn collect_source_files(path: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
    if path.is_file() {
        files.push(path.to_path_buf());
        return Ok(());
    }
    let entries = fs::read_dir(path).map_err(|error| {
        format!(
            "Could not inspect Ticket 03 source {}: {error}",
            path.display()
        )
    })?;
    for entry in entries {
        let entry =
            entry.map_err(|error| format!("Could not inspect Ticket 03 source: {error}"))?;
        let path = entry.path();
        if path.is_dir() {
            collect_source_files(&path, files)?;
        } else if matches!(
            path.extension().and_then(|extension| extension.to_str()),
            Some("rs" | "ts" | "tsx" | "css" | "toml")
        ) {
            files.push(path);
        }
    }
    Ok(())
}

fn hex_string(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        encoded.push(HEX[(byte >> 4) as usize] as char);
        encoded.push(HEX[(byte & 0x0f) as usize] as char);
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::{allows_uncertified_build, normalize_build_version};

    #[test]
    fn only_debug_builds_may_run_without_release_certification() {
        assert!(allows_uncertified_build(Some("debug")));
        assert!(!allows_uncertified_build(Some("release")));
        assert!(!allows_uncertified_build(Some("production")));
        assert!(!allows_uncertified_build(None));
    }

    #[test]
    fn fingerprint_text_is_stable_across_checkout_line_endings() {
        let lf = normalize_build_version("source.rs", b"first\nsecond\n".to_vec());
        let crlf = normalize_build_version("source.rs", b"first\r\nsecond\r\n".to_vec());
        let mixed = normalize_build_version("source.rs", b"first\r\nsecond\n".to_vec());
        let changed = normalize_build_version("source.rs", b"first\nchanged\n".to_vec());

        assert_eq!(lf, crlf);
        assert_eq!(lf, mixed);
        assert_ne!(lf, changed);
    }
}
