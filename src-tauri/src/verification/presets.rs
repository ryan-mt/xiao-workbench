use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::fs::{self, File};
use std::io::Read;
use std::path::Path;

use serde::Deserialize;

use super::executor::resolve_command_executable_with_environment;
use super::models::{
    AcceptanceContractDraft, AcceptanceContractPreset, AcceptanceGate,
    AcceptancePresetDiscoveryError, AcceptancePresetDiscoveryErrorCode, PackageManager,
};

const MAX_PACKAGE_MANIFEST_BYTES: usize = 256 * 1024;
const PACKAGE_SCRIPT_TIMEOUT_MS: u64 = 10 * 60 * 1_000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PackageManifest {
    package_manager: Option<String>,
    scripts: Option<BTreeMap<String, String>>,
}

pub(crate) fn discover_acceptance_presets(
    execution_root: &Path,
) -> Result<Vec<AcceptanceContractPreset>, AcceptancePresetDiscoveryError> {
    let path_environment = std::env::var_os("PATH");
    let path_extensions = std::env::var_os("PATHEXT");
    discover_acceptance_presets_with_environment(
        execution_root,
        path_environment.as_deref(),
        path_extensions.as_deref(),
    )
}

fn discover_acceptance_presets_with_environment(
    execution_root: &Path,
    path_environment: Option<&OsStr>,
    path_extensions: Option<&OsStr>,
) -> Result<Vec<AcceptanceContractPreset>, AcceptancePresetDiscoveryError> {
    let manifest_path = execution_root.join("package.json");
    let metadata = match fs::metadata(&manifest_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(AcceptancePresetDiscoveryError::new(
                AcceptancePresetDiscoveryErrorCode::ManifestRead,
                format!("Could not inspect package.json: {error}"),
            ));
        }
    };
    if metadata.len() > MAX_PACKAGE_MANIFEST_BYTES as u64 {
        return Err(manifest_too_large_error());
    }

    let file = File::open(&manifest_path).map_err(|error| {
        AcceptancePresetDiscoveryError::new(
            AcceptancePresetDiscoveryErrorCode::ManifestRead,
            format!("Could not read package.json: {error}"),
        )
    })?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take((MAX_PACKAGE_MANIFEST_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| {
            AcceptancePresetDiscoveryError::new(
                AcceptancePresetDiscoveryErrorCode::ManifestRead,
                format!("Could not read package.json: {error}"),
            )
        })?;
    if bytes.len() > MAX_PACKAGE_MANIFEST_BYTES {
        return Err(manifest_too_large_error());
    }
    let manifest: PackageManifest = serde_json::from_slice(&bytes).map_err(|error| {
        AcceptancePresetDiscoveryError::new(
            AcceptancePresetDiscoveryErrorCode::MalformedManifest,
            format!("package.json is malformed: {error}"),
        )
    })?;
    let scripts = manifest.scripts.unwrap_or_default();
    if scripts.is_empty() {
        return Ok(Vec::new());
    }

    let package_manager =
        detect_package_manager(execution_root, manifest.package_manager.as_deref())?;
    let executable = resolve_package_manager_executable(
        execution_root,
        package_manager,
        path_environment,
        path_extensions,
    )
    .ok_or_else(|| {
        AcceptancePresetDiscoveryError::new(
            AcceptancePresetDiscoveryErrorCode::PackageManagerUnavailable,
            format!(
                "Could not resolve `{}` on PATH.",
                package_manager.executable_name()
            ),
        )
    })?;

    Ok(scripts
        .into_keys()
        .filter(|script_name| is_safe_script_name(script_name))
        .map(|script_name| AcceptanceContractPreset {
            draft: AcceptanceContractDraft {
                name: format!("Package script: {script_name}"),
                gates: vec![AcceptanceGate::Command {
                    executable: executable.clone(),
                    argv: vec!["run".to_owned(), script_name.clone()],
                    timeout_ms: PACKAGE_SCRIPT_TIMEOUT_MS,
                    expected_exit_codes: vec![0],
                }],
            },
            script_name,
            package_manager,
        })
        .collect())
}

fn detect_package_manager(
    execution_root: &Path,
    declared: Option<&str>,
) -> Result<PackageManager, AcceptancePresetDiscoveryError> {
    if let Some(declared) = declared.map(str::trim).filter(|value| !value.is_empty()) {
        let name = declared.split('@').next().unwrap_or_default();
        return package_manager_from_name(name).ok_or_else(|| {
            AcceptancePresetDiscoveryError::new(
                AcceptancePresetDiscoveryErrorCode::UnsupportedPackageManager,
                format!("Unsupported package manager `{declared}`."),
            )
        });
    }
    if execution_root.join("pnpm-lock.yaml").is_file() {
        return Ok(PackageManager::Pnpm);
    }
    if execution_root.join("yarn.lock").is_file() {
        return Ok(PackageManager::Yarn);
    }
    if execution_root.join("bun.lock").is_file() || execution_root.join("bun.lockb").is_file() {
        return Ok(PackageManager::Bun);
    }
    Ok(PackageManager::Npm)
}

fn package_manager_from_name(value: &str) -> Option<PackageManager> {
    match value.trim().to_ascii_lowercase().as_str() {
        "npm" => Some(PackageManager::Npm),
        "pnpm" => Some(PackageManager::Pnpm),
        "yarn" => Some(PackageManager::Yarn),
        "bun" => Some(PackageManager::Bun),
        _ => None,
    }
}

fn resolve_package_manager_executable(
    execution_root: &Path,
    package_manager: PackageManager,
    path_environment: Option<&OsStr>,
    path_extensions: Option<&OsStr>,
) -> Option<String> {
    let executable = package_manager.executable_name();
    resolve_command_executable_with_environment(
        execution_root,
        executable,
        path_environment,
        path_extensions,
    )
    .ok()?;
    Some(executable.to_owned())
}

fn is_safe_script_name(script_name: &str) -> bool {
    !script_name.is_empty() && script_name.trim() == script_name && !script_name.starts_with('-')
}

fn manifest_too_large_error() -> AcceptancePresetDiscoveryError {
    AcceptancePresetDiscoveryError::new(
        AcceptancePresetDiscoveryErrorCode::ManifestTooLarge,
        format!(
            "package.json exceeds the {} KiB discovery limit.",
            MAX_PACKAGE_MANIFEST_BYTES / 1024
        ),
    )
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;

    static NEXT_DIRECTORY: AtomicU64 = AtomicU64::new(1);

    struct TestDirectory {
        base: PathBuf,
        root: PathBuf,
        external_bin: PathBuf,
    }

    impl TestDirectory {
        fn new(label: &str) -> Self {
            let base = std::env::temp_dir().join(format!(
                "xiao-m5-presets-{label}-{}-{}",
                std::process::id(),
                NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed)
            ));
            let _ = fs::remove_dir_all(&base);
            let root = base.join("workspace");
            let external_bin = base.join("external-bin");
            fs::create_dir_all(&root).unwrap();
            fs::create_dir_all(&external_bin).unwrap();
            Self {
                base,
                root,
                external_bin,
            }
        }

        fn executable(&self, package_manager: PackageManager) -> PathBuf {
            self.executable_in(&self.external_bin, package_manager)
        }

        fn executable_in(&self, directory: &Path, package_manager: PackageManager) -> PathBuf {
            fs::create_dir_all(directory).unwrap();
            #[cfg(windows)]
            let name = format!("{}.CMD", package_manager.executable_name());
            #[cfg(not(windows))]
            let name = package_manager.executable_name();
            let path = directory.join(name);
            #[cfg(windows)]
            fs::write(&path, b"@exit /b 0\r\n").unwrap();
            #[cfg(not(windows))]
            {
                use std::os::unix::fs::PermissionsExt as _;

                fs::write(&path, b"#!/bin/sh\nexit 0\n").unwrap();
                let mut permissions = fs::metadata(&path).unwrap().permissions();
                permissions.set_mode(0o755);
                fs::set_permissions(&path, permissions).unwrap();
            }
            path
        }

        fn path_environment(&self) -> std::ffi::OsString {
            self.external_bin.clone().into_os_string()
        }

        fn discover(
            &self,
            path_environment: Option<&OsStr>,
        ) -> Result<Vec<AcceptanceContractPreset>, AcceptancePresetDiscoveryError> {
            discover_acceptance_presets_with_environment(
                &self.root,
                path_environment,
                path_extensions(),
            )
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }

    #[cfg(windows)]
    fn path_extensions() -> Option<&'static OsStr> {
        Some(OsStr::new(".CMD"))
    }

    #[cfg(not(windows))]
    fn path_extensions() -> Option<&'static OsStr> {
        None
    }

    #[test]
    fn package_manager_metadata_wins_and_script_prose_is_never_executed() {
        let directory = TestDirectory::new("package-manager");
        let executable = directory.executable(PackageManager::Pnpm);
        fs::write(directory.root.join("package-lock.json"), b"{}").unwrap();
        fs::write(
            directory.root.join("package.json"),
            br#"{
                "packageManager": "pnpm@9.1.0",
                "scripts": {
                    "test": "vitest && echo should-not-be-argv",
                    "typecheck": "tsc --noEmit"
                }
            }"#,
        )
        .unwrap();

        let path = directory.path_environment();
        let presets = directory.discover(Some(&path)).unwrap();
        assert_eq!(presets.len(), 2);
        assert!(presets
            .iter()
            .all(|preset| preset.package_manager == PackageManager::Pnpm));
        let test = presets
            .iter()
            .find(|preset| preset.script_name == "test")
            .unwrap();
        let AcceptanceGate::Command {
            executable: actual_executable,
            argv,
            ..
        } = &test.draft.gates[0]
        else {
            panic!("expected command preset")
        };
        assert_eq!(actual_executable, "pnpm");
        assert_eq!(
            resolve_command_executable_with_environment(
                &directory.root,
                actual_executable,
                Some(&path),
                path_extensions(),
            )
            .unwrap(),
            fs::canonicalize(executable).unwrap()
        );
        assert_eq!(argv, &["run", "test"]);
        assert!(!argv.iter().any(|argument| argument.contains("echo")));
    }

    #[test]
    fn workspace_package_manager_shadows_are_rejected_and_external_manager_stays_bare() {
        let directory = TestDirectory::new("executable-origin");
        fs::write(
            directory.root.join("package.json"),
            br#"{"scripts":{"test":"echo safe"}}"#,
        )
        .unwrap();
        let _shadow = directory.executable_in(&directory.root, PackageManager::Npm);
        let workspace_path = std::env::join_paths([&directory.root]).unwrap();
        assert_eq!(
            directory.discover(Some(&workspace_path)).unwrap_err().code,
            AcceptancePresetDiscoveryErrorCode::PackageManagerUnavailable
        );

        #[cfg(unix)]
        {
            let linked_bin = directory.base.join("linked-bin");
            fs::create_dir_all(&linked_bin).unwrap();
            std::os::unix::fs::symlink(&_shadow, linked_bin.join("npm")).unwrap();
            let linked_path = std::env::join_paths([&linked_bin]).unwrap();
            assert_eq!(
                directory.discover(Some(&linked_path)).unwrap_err().code,
                AcceptancePresetDiscoveryErrorCode::PackageManagerUnavailable
            );
        }

        let external = directory.executable(PackageManager::Npm);
        let safe_path = std::env::join_paths([&directory.root, &directory.external_bin]).unwrap();
        let presets = directory.discover(Some(&safe_path)).unwrap();
        let AcceptanceGate::Command { executable, .. } = &presets[0].draft.gates[0] else {
            panic!("expected command preset")
        };
        assert_eq!(executable, "npm");
        assert_eq!(
            resolve_command_executable_with_environment(
                &directory.root,
                executable,
                Some(&safe_path),
                path_extensions(),
            )
            .unwrap(),
            fs::canonicalize(external).unwrap()
        );
    }

    #[test]
    fn option_like_or_trim_invalid_script_names_cannot_create_false_pass_presets() {
        let directory = TestDirectory::new("script-options");
        directory.executable(PackageManager::Npm);
        fs::write(
            directory.root.join("package.json"),
            br#"{
                "scripts": {
                    "": "exit 99",
                    " ": "exit 99",
                    "--": "exit 99",
                    "--if-present": "exit 99",
                    "-s": "exit 99",
                    " test": "exit 99",
                    "test ": "exit 99",
                    "test": "exit 0"
                }
            }"#,
        )
        .unwrap();

        let path = directory.path_environment();
        let presets = directory.discover(Some(&path)).unwrap();
        assert_eq!(presets.len(), 1);
        assert_eq!(presets[0].script_name, "test");
        let AcceptanceGate::Command { argv, .. } = &presets[0].draft.gates[0] else {
            panic!("expected command preset")
        };
        assert_eq!(argv, &["run", "test"]);
    }

    #[test]
    fn lockfile_selects_package_manager_when_manifest_does_not() {
        let directory = TestDirectory::new("lockfile");
        directory.executable(PackageManager::Yarn);
        fs::write(directory.root.join("yarn.lock"), b"").unwrap();
        fs::write(
            directory.root.join("package.json"),
            br#"{"scripts":{"build":"vite build"}}"#,
        )
        .unwrap();

        let path = directory.path_environment();
        let presets = directory.discover(Some(&path)).unwrap();
        assert_eq!(presets.len(), 1);
        assert_eq!(presets[0].package_manager, PackageManager::Yarn);
    }

    #[test]
    fn missing_manifest_or_scripts_returns_no_presets() {
        let directory = TestDirectory::new("missing");
        assert!(directory.discover(None).unwrap().is_empty());
        fs::write(directory.root.join("package.json"), br#"{"name":"empty"}"#).unwrap();
        assert!(directory.discover(None).unwrap().is_empty());
    }

    #[test]
    fn malformed_and_oversized_manifests_return_typed_errors() {
        let malformed = TestDirectory::new("malformed");
        fs::write(malformed.root.join("package.json"), b"{not-json").unwrap();
        assert_eq!(
            malformed.discover(None).unwrap_err().code,
            AcceptancePresetDiscoveryErrorCode::MalformedManifest
        );

        let oversized = TestDirectory::new("oversized");
        fs::write(
            oversized.root.join("package.json"),
            vec![b' '; MAX_PACKAGE_MANIFEST_BYTES + 1],
        )
        .unwrap();
        assert_eq!(
            oversized.discover(None).unwrap_err().code,
            AcceptancePresetDiscoveryErrorCode::ManifestTooLarge
        );
    }

    #[test]
    fn unsupported_or_unavailable_package_managers_return_typed_errors() {
        let unsupported = TestDirectory::new("unsupported");
        fs::write(
            unsupported.root.join("package.json"),
            br#"{"packageManager":"deno@2","scripts":{"test":"deno test"}}"#,
        )
        .unwrap();
        assert_eq!(
            unsupported.discover(None).unwrap_err().code,
            AcceptancePresetDiscoveryErrorCode::UnsupportedPackageManager
        );

        let unavailable = TestDirectory::new("unavailable");
        fs::write(
            unavailable.root.join("package.json"),
            br#"{"scripts":{"test":"echo never parsed"}}"#,
        )
        .unwrap();
        assert_eq!(
            unavailable.discover(None).unwrap_err().code,
            AcceptancePresetDiscoveryErrorCode::PackageManagerUnavailable
        );
        assert!(resolve_package_manager_executable(
            &unavailable.root,
            PackageManager::Npm,
            Some(OsStr::new("relative-bin")),
            path_extensions(),
        )
        .is_none());
    }
}
