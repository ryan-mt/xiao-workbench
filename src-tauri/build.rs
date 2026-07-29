use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

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
    synchronize_ticket03_source()
        .expect("Ticket 03 source fingerprint could not be synchronized before the build");
    let certification = validate_ticket03_certification()
        .expect("Ticket 03 release certification does not match the verified source");
    if let Some(certification) = certification {
        println!("cargo:rustc-env=XIAO_TICKET03_RELEASE_CERTIFIED={certification}");
    } else {
        println!(
            "cargo:warning=Ticket 03 source is synchronized but pending the pre-commit release gates"
        );
    }
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(APP_COMMANDS)),
    )
    .expect("failed to build Xiao's Tauri manifest");
    #[cfg(target_os = "windows")]
    println!(
        "cargo:rustc-link-search=native={}",
        PathBuf::from(std::env::var("OUT_DIR").expect("build output directory")).display()
    );
}

fn synchronize_ticket03_source() -> Result<(), String> {
    let root = workspace_root()?;
    let output = Command::new("node")
        .arg(root.join("scripts/sync-ticket03-certification.mjs"))
        .current_dir(root)
        .output()
        .map_err(|error| format!("Could not start the Ticket 03 source sync: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "Ticket 03 source sync failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(())
}

fn workspace_root() -> Result<PathBuf, String> {
    Ok(PathBuf::from(
        std::env::var("CARGO_MANIFEST_DIR")
            .map_err(|error| format!("Could not locate the Cargo manifest: {error}"))?,
    )
    .parent()
    .ok_or("The Cargo manifest has no workspace parent.")?
    .to_path_buf())
}

fn validate_ticket03_certification() -> Result<Option<String>, String> {
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

    let root = workspace_root()?;
    let certification_path =
        root.join("src/features/release-assurance/ticket03-certification.json");
    println!("cargo:rerun-if-changed={}", certification_path.display());
    let bytes = fs::read(&certification_path)
        .map_err(|error| format!("Could not read Ticket 03 certification: {error}"))?;
    let document: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Could not decode Ticket 03 certification: {error}"))?;
    if document["baselineCommit"] != "fda6486233e0b2f07ecfea166e1a94533cb923c4"
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
            "Ticket 03 source fingerprint changed: recorded {expected}, current {actual}. Run `npm run certification:sync` before invoking Cargo directly"
        ));
    }
    match document["status"].as_str() {
        Some("pending") => return Ok(None),
        Some("passed") => {}
        _ => return Err("Ticket 03 certification status is invalid.".to_owned()),
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
    Ok(Some(actual))
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
    let files = ticket03_source_manifest(root)?;
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

fn ticket03_source_manifest(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut files = Vec::new();
    collect_workspace_sources(root, root, &mut files)?;
    files.sort();
    Ok(files)
}

fn collect_workspace_sources(
    root: &Path,
    path: &Path,
    files: &mut Vec<PathBuf>,
) -> Result<(), String> {
    let mut entries = fs::read_dir(path)
        .map_err(|error| {
            format!(
                "Could not inspect Ticket 03 source {}: {error}",
                path.display()
            )
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not inspect Ticket 03 source: {error}"))?;
    entries.sort_by_key(|entry| entry.file_name());

    for entry in entries {
        let path = entry.path();
        let relative = path
            .strip_prefix(root)
            .map_err(|_| "A Ticket 03 source escaped the workspace root.".to_owned())?
            .to_string_lossy()
            .replace('\\', "/");
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Could not inspect Ticket 03 source {relative}: {error}"))?;
        if file_type.is_dir() {
            if !excluded_source_directory(&relative) {
                collect_workspace_sources(root, &path, files)?;
            }
        } else if file_type.is_file() {
            if certified_source_file(&relative) {
                files.push(path);
            } else if release_source_candidate(&relative) && !excluded_source_file(&relative) {
                return Err(format!(
                    "Release source lies outside Ticket 03 fingerprint coverage: {relative}"
                ));
            }
        }
    }
    Ok(())
}

fn certified_source_file(relative: &str) -> bool {
    const ROOT_FILES: &[&str] = &[
        "README.md",
        "index.html",
        "package-lock.json",
        "package.json",
        "tsconfig.app.json",
        "tsconfig.json",
        "tsconfig.node.json",
        "vite.config.ts",
    ];
    (relative.starts_with("public/")
        || relative.starts_with("scripts/")
        || relative.starts_with("src/")
        || relative.starts_with("src-tauri/"))
        && !excluded_source_file(relative)
        || ROOT_FILES.contains(&relative)
}

fn excluded_source_directory(relative: &str) -> bool {
    relative.split('/').any(|component| {
        matches!(
            component,
            ".git"
                | ".hermes"
                | ".next"
                | ".ok"
                | ".pi"
                | ".scratch"
                | ".vite"
                | "coverage"
                | "dist"
                | "docs"
                | "gen"
                | "node_modules"
                | "plans"
                | "target"
        )
    })
}

fn excluded_source_file(relative: &str) -> bool {
    matches!(
        relative,
        "src/features/release-assurance/ticket03-certification.json"
            | "src/features/release-assurance/ticket03-verification.md"
    )
}

fn release_source_candidate(relative: &str) -> bool {
    matches!(
        Path::new(relative)
            .extension()
            .and_then(|extension| extension.to_str()),
        Some(
            "c" | "cc"
                | "cpp"
                | "css"
                | "h"
                | "html"
                | "js"
                | "json"
                | "jsx"
                | "lock"
                | "mjs"
                | "rs"
                | "scss"
                | "toml"
                | "ts"
                | "tsx"
                | "vue"
                | "yaml"
                | "yml"
        )
    )
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
    use super::{normalize_build_version, ticket03_source_fingerprint, ticket03_source_manifest};
    use std::collections::BTreeSet;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    fn workspace_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("Cargo manifest should have a workspace parent")
            .to_path_buf()
    }

    fn relative_paths(root: &Path, files: Vec<PathBuf>) -> BTreeSet<String> {
        files
            .into_iter()
            .map(|path| {
                path.strip_prefix(root)
                    .expect("manifest source should remain under the workspace")
                    .to_string_lossy()
                    .replace('\\', "/")
            })
            .collect()
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

    #[test]
    fn node_sync_uses_the_build_script_fingerprint() {
        let root = workspace_root();
        let output = Command::new("node")
            .arg(root.join("scripts/sync-ticket03-certification.mjs"))
            .arg("--print")
            .output()
            .expect("Node should run the Ticket 03 fingerprint sync");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let node = String::from_utf8(output.stdout)
            .expect("Node fingerprint should be UTF-8")
            .trim()
            .to_owned();
        let rust = ticket03_source_fingerprint(&root)
            .expect("Rust should compute the Ticket 03 source fingerprint");

        assert_eq!(node, rust);
    }

    #[test]
    fn source_manifest_covers_complete_frontend_and_backend_trees() {
        let root = workspace_root();
        let manifest = relative_paths(
            &root,
            ticket03_source_manifest(&root).expect("release source manifest should be complete"),
        );

        assert!(manifest.contains("src/app/LazyLoadBoundary.tsx"));
        assert!(manifest.contains("src/app/LazyLoadBoundary.test.tsx"));
        assert!(manifest.contains("src-tauri/src/time_travel/repository.rs"));
        assert!(manifest.contains("scripts/sync-build-version.mjs"));
        assert!(manifest.contains("src-tauri/tests/build_certification.rs"));
        assert!(!manifest.contains("src/features/release-assurance/ticket03-certification.json"));
        assert!(!manifest.contains("src/features/release-assurance/ticket03-verification.md"));
    }

    #[test]
    fn source_manifest_rejects_release_source_outside_coverage() {
        let root =
            std::env::temp_dir().join(format!("xiao-build-certification-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("unexpected")).expect("temporary source directory");
        fs::write(root.join("unexpected/release.ts"), "export {};\n")
            .expect("temporary release source");

        let error = ticket03_source_manifest(&root)
            .expect_err("uncovered release source must fail certification");
        assert!(error.contains("unexpected/release.ts"), "{error}");

        fs::remove_dir_all(root).expect("temporary source cleanup");
    }
}
