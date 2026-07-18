use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Read as _, Write as _};
use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

const ARTIFACT_DIRECTORY_NAME: &str = "verification-artifacts";
const MAX_ARTIFACT_JSON_BYTES: usize = 128 * 1024 * 1024;
const MAX_ARTIFACT_ID_BYTES: usize = 128;

#[derive(Debug, Clone)]
pub(crate) struct ArtifactStore {
    root: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct StoredArtifactFile {
    pub relative_storage_path: String,
    pub byte_length: u64,
    pub sha256: String,
}

impl ArtifactStore {
    pub(crate) fn open(app_data_dir: &Path) -> Result<Self, String> {
        fs::create_dir_all(app_data_dir)
            .map_err(|error| format!("Could not create Xiao app-data directory: {error}"))?;
        let app_data_dir = fs::canonicalize(app_data_dir)
            .map_err(|error| format!("Could not resolve Xiao app-data directory: {error}"))?;
        let root = app_data_dir.join(ARTIFACT_DIRECTORY_NAME);
        fs::create_dir_all(&root)
            .map_err(|error| format!("Could not create verification artifact root: {error}"))?;
        let root_metadata = fs::symlink_metadata(&root)
            .map_err(|error| format!("Could not inspect verification artifact root: {error}"))?;
        if is_link_or_reparse(&root_metadata) || !root_metadata.is_dir() {
            return Err("The verification artifact root is unsafe.".to_owned());
        }
        let root = fs::canonicalize(root)
            .map_err(|error| format!("Could not resolve verification artifact root: {error}"))?;
        if !path_is_within(&root, &app_data_dir) {
            return Err("The verification artifact root escapes Xiao app data.".to_owned());
        }
        Ok(Self { root })
    }

    pub(crate) fn write_json<T: Serialize>(
        &self,
        run_id: &str,
        verification_attempt_id: Option<&str>,
        artifact_id: &str,
        value: &T,
    ) -> Result<StoredArtifactFile, String> {
        validate_id(run_id, "run")?;
        if let Some(attempt_id) = verification_attempt_id {
            validate_id(attempt_id, "verification attempt")?;
        }
        validate_id(artifact_id, "artifact")?;
        let bytes = canonical_json_bytes_with_limit(value, MAX_ARTIFACT_JSON_BYTES)?;
        let relative_storage_path =
            relative_artifact_path(run_id, verification_attempt_id, artifact_id);
        let relative_path = validate_relative_storage_path(&relative_storage_path)?;
        let destination = self.root.join(&relative_path);
        let parent = destination
            .parent()
            .ok_or("The verification artifact destination has no parent directory.")?;
        let parent = create_artifact_directory_components(&self.root, parent)?;
        let destination = parent.join(
            destination
                .file_name()
                .ok_or("The verification artifact filename is missing.")?,
        );
        if destination.exists() {
            return Err("The verification artifact already exists.".to_owned());
        }

        let temporary = parent.join(format!(
            ".{artifact_id}.{}.tmp",
            crate::runs::repository::new_uuid_v7()
        ));
        let write_result = write_new_file(&temporary, &bytes).and_then(|()| {
            fs::rename(&temporary, &destination)
                .map_err(|error| format!("Could not publish verification artifact: {error}"))
        });
        if let Err(error) = write_result {
            let _ = fs::remove_file(&temporary);
            return Err(error);
        }

        let canonical_destination = fs::canonicalize(&destination).map_err(|error| {
            let _ = fs::remove_file(&destination);
            format!("Could not resolve the published verification artifact: {error}")
        })?;
        if !path_is_within(&canonical_destination, &self.root) || !canonical_destination.is_file() {
            let _ = fs::remove_file(&destination);
            return Err("The published verification artifact is unsafe.".to_owned());
        }
        Ok(StoredArtifactFile {
            relative_storage_path,
            byte_length: u64::try_from(bytes.len()).unwrap_or(u64::MAX),
            sha256: sha256_hex(&bytes),
        })
    }

    pub(crate) fn read_json<T: DeserializeOwned>(
        &self,
        relative_storage_path: &str,
        expected_byte_length: u64,
        expected_sha256: &str,
    ) -> Result<T, String> {
        if !is_sha256(expected_sha256) {
            return Err("The stored verification artifact checksum is invalid.".to_owned());
        }
        let relative_path = validate_relative_storage_path(relative_storage_path)?;
        let path = self.root.join(relative_path);
        let path = fs::canonicalize(path)
            .map_err(|error| format!("Could not resolve verification artifact: {error}"))?;
        if !path_is_within(&path, &self.root) || !path.is_file() {
            return Err("The verification artifact path is unsafe.".to_owned());
        }
        let metadata = fs::metadata(&path)
            .map_err(|error| format!("Could not inspect verification artifact: {error}"))?;
        if metadata.len() != expected_byte_length {
            return Err(
                "The verification artifact byte length does not match its record.".to_owned(),
            );
        }
        if metadata.len() > u64::try_from(MAX_ARTIFACT_JSON_BYTES).unwrap_or(u64::MAX) {
            return Err("The verification artifact exceeds its safety limit.".to_owned());
        }
        let mut file = File::open(&path)
            .map_err(|error| format!("Could not open verification artifact: {error}"))?;
        let capacity = usize::try_from(metadata.len())
            .map_err(|_| "The verification artifact is too large to read.".to_owned())?;
        let mut bytes = Vec::with_capacity(capacity);
        file.read_to_end(&mut bytes)
            .map_err(|error| format!("Could not read verification artifact: {error}"))?;
        if u64::try_from(bytes.len()).unwrap_or(u64::MAX) != expected_byte_length
            || sha256_hex(&bytes) != expected_sha256
        {
            return Err("The verification artifact failed integrity verification.".to_owned());
        }
        serde_json::from_slice(&bytes)
            .map_err(|error| format!("Could not decode verification artifact: {error}"))
    }

    pub(crate) fn remove(&self, relative_storage_path: &str) -> Result<(), String> {
        let relative_path = validate_relative_storage_path(relative_storage_path)?;
        let path = self.root.join(relative_path);
        let Some(metadata) = inspect_lexical_artifact_path(&self.root, &path)? else {
            return Ok(());
        };
        if !metadata.is_file() {
            return Err("The verification artifact removal path is unsafe.".to_owned());
        }
        fs::remove_file(&path)
            .map_err(|error| format!("Could not remove verification artifact: {error}"))
    }

    pub(crate) fn remove_run(&self, run_id: &str) -> Result<(), String> {
        validate_id(run_id, "run")?;
        let path = self.root.join("runs").join(run_id);
        let Some(metadata) = inspect_lexical_artifact_path(&self.root, &path)? else {
            return Ok(());
        };
        if !metadata.is_dir() {
            return Err("The verification artifact run directory is unsafe.".to_owned());
        }
        inspect_artifact_directory_tree(&self.root, &path)?;
        fs::remove_dir_all(&path)
            .map_err(|error| format!("Could not remove verification artifact run: {error}"))
    }

    pub(crate) fn reconcile_owned_files(
        &self,
        owned_relative_paths: &HashSet<String>,
    ) -> Result<(), String> {
        let owned_paths = owned_relative_paths
            .iter()
            .map(|path| validate_relative_storage_path(path))
            .collect::<Result<HashSet<_>, _>>()?;
        let runs = self.root.join("runs");
        let Some(metadata) = inspect_lexical_artifact_path(&self.root, &runs)? else {
            return Ok(());
        };
        if !metadata.is_dir() {
            return Err("The verification artifact runs directory is unsafe.".to_owned());
        }

        let mut files_to_remove = Vec::new();
        let mut directories = Vec::new();
        collect_orphaned_artifact_entries(
            &self.root,
            &runs,
            &owned_paths,
            &mut files_to_remove,
            &mut directories,
        )?;
        for path in files_to_remove {
            remove_swept_artifact_file(&self.root, &path)?;
        }
        for path in directories {
            remove_empty_artifact_directory(&self.root, &path)?;
        }
        Ok(())
    }
}

fn is_link_or_reparse(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    {
        false
    }
}

fn create_artifact_directory_components(root: &Path, path: &Path) -> Result<PathBuf, String> {
    let root_metadata = fs::symlink_metadata(root)
        .map_err(|error| format!("Could not inspect verification artifact root: {error}"))?;
    if is_link_or_reparse(&root_metadata) || !root_metadata.is_dir() {
        return Err("The verification artifact root is unsafe.".to_owned());
    }
    let relative = path
        .strip_prefix(root)
        .map_err(|_| "A verification artifact path escapes its store.".to_owned())?;

    let mut current = root.to_path_buf();
    for component in relative.components() {
        if !matches!(component, std::path::Component::Normal(_)) {
            return Err("A verification artifact path is unsafe.".to_owned());
        }
        current.push(component);
        let metadata = match fs::symlink_metadata(&current) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&current).map_err(|error| {
                    format!("Could not create verification artifact directory: {error}")
                })?;
                fs::symlink_metadata(&current).map_err(|error| {
                    format!("Could not inspect verification artifact directory: {error}")
                })?
            }
            Err(error) => {
                return Err(format!(
                    "Could not inspect a verification artifact path: {error}"
                ));
            }
        };
        if is_link_or_reparse(&metadata) {
            return Err(
                "A verification artifact path traverses a link or reparse point.".to_owned(),
            );
        }
        if !metadata.is_dir() {
            return Err("A verification artifact path ancestor is unsafe.".to_owned());
        }
    }

    let canonical = fs::canonicalize(&current)
        .map_err(|error| format!("Could not resolve verification artifact directory: {error}"))?;
    if !path_is_within(&canonical, root) {
        return Err("The verification artifact directory escapes its store.".to_owned());
    }
    Ok(canonical)
}

fn inspect_lexical_artifact_path(root: &Path, path: &Path) -> Result<Option<fs::Metadata>, String> {
    let root_metadata = match fs::symlink_metadata(root) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "Could not inspect verification artifact root: {error}"
            ));
        }
    };
    if is_link_or_reparse(&root_metadata) || !root_metadata.is_dir() {
        return Err("The verification artifact root is unsafe.".to_owned());
    }
    let relative = path
        .strip_prefix(root)
        .map_err(|_| "A verification artifact path escapes its store.".to_owned())?;
    if relative.as_os_str().is_empty() {
        return Ok(Some(root_metadata));
    }

    let mut current = root.to_path_buf();
    let mut components = relative.components().peekable();
    while let Some(component) = components.next() {
        if !matches!(component, std::path::Component::Normal(_)) {
            return Err("A verification artifact path is unsafe.".to_owned());
        }
        current.push(component);
        let metadata = match fs::symlink_metadata(&current) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                return Err(format!(
                    "Could not inspect a verification artifact path: {error}"
                ));
            }
        };
        if is_link_or_reparse(&metadata) {
            return Err(
                "A verification artifact path traverses a link or reparse point.".to_owned(),
            );
        }
        if components.peek().is_some() && !metadata.is_dir() {
            return Err("A verification artifact path ancestor is unsafe.".to_owned());
        }
        if components.peek().is_none() {
            return Ok(Some(metadata));
        }
    }
    Ok(Some(root_metadata))
}

fn inspect_artifact_directory_tree(root: &Path, directory: &Path) -> Result<(), String> {
    let Some(metadata) = inspect_lexical_artifact_path(root, directory)? else {
        return Ok(());
    };
    if !metadata.is_dir() {
        return Err("A verification artifact directory is unsafe.".to_owned());
    }
    let entries = fs::read_dir(directory)
        .map_err(|error| format!("Could not inspect verification artifact directory: {error}"))?;
    for entry in entries {
        let entry = entry
            .map_err(|error| format!("Could not inspect a verification artifact entry: {error}"))?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| format!("Could not inspect a verification artifact entry: {error}"))?;
        if is_link_or_reparse(&metadata) {
            return Err("A verification artifact entry is a link or reparse point.".to_owned());
        }
        if metadata.is_dir() {
            inspect_artifact_directory_tree(root, &path)?;
        }
    }
    Ok(())
}

fn collect_orphaned_artifact_entries(
    root: &Path,
    directory: &Path,
    owned_paths: &HashSet<PathBuf>,
    files_to_remove: &mut Vec<PathBuf>,
    directories: &mut Vec<PathBuf>,
) -> Result<(), String> {
    let Some(metadata) = inspect_lexical_artifact_path(root, directory)? else {
        return Ok(());
    };
    if !metadata.is_dir() {
        return Err("A verification artifact directory is unsafe.".to_owned());
    }
    let entries = fs::read_dir(directory)
        .map_err(|error| format!("Could not inspect verification artifact directory: {error}"))?;
    for entry in entries {
        let entry = entry
            .map_err(|error| format!("Could not inspect a verification artifact entry: {error}"))?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| format!("Could not inspect a verification artifact entry: {error}"))?;
        if is_link_or_reparse(&metadata) {
            return Err("A verification artifact entry is a link or reparse point.".to_owned());
        }
        if metadata.is_dir() {
            collect_orphaned_artifact_entries(
                root,
                &path,
                owned_paths,
                files_to_remove,
                directories,
            )?;
            directories.push(path);
            continue;
        }
        if !metadata.is_file() {
            return Err("A verification artifact entry has an unsafe file type.".to_owned());
        }
        let is_artifact_file = path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.ends_with(".json") || name.ends_with(".tmp"));
        if !is_artifact_file {
            continue;
        }
        let relative = path
            .strip_prefix(root)
            .map_err(|_| "A verification artifact entry escapes its store.".to_owned())?;
        if !owned_paths.contains(relative) {
            files_to_remove.push(path);
        }
    }
    Ok(())
}

fn remove_swept_artifact_file(root: &Path, path: &Path) -> Result<(), String> {
    let Some(metadata) = inspect_lexical_artifact_path(root, path)? else {
        return Ok(());
    };
    if !metadata.is_file() {
        return Err("An orphaned verification artifact path is unsafe.".to_owned());
    }
    fs::remove_file(path)
        .map_err(|error| format!("Could not remove orphaned verification artifact: {error}"))
}

fn remove_empty_artifact_directory(root: &Path, path: &Path) -> Result<(), String> {
    let Some(metadata) = inspect_lexical_artifact_path(root, path)? else {
        return Ok(());
    };
    if !metadata.is_dir() || path == root {
        return Err("An orphaned verification artifact directory is unsafe.".to_owned());
    }
    match fs::remove_dir(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::DirectoryNotEmpty => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "Could not remove orphaned verification artifact directory: {error}"
        )),
    }
}

fn write_new_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| format!("Could not create verification artifact: {error}"))?;
    file.write_all(bytes)
        .map_err(|error| format!("Could not write verification artifact: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("Could not flush verification artifact: {error}"))
}

fn relative_artifact_path(
    run_id: &str,
    verification_attempt_id: Option<&str>,
    artifact_id: &str,
) -> String {
    match verification_attempt_id {
        Some(attempt_id) => {
            format!("runs/{run_id}/attempts/{attempt_id}/{artifact_id}.json")
        }
        None => format!("runs/{run_id}/baseline/{artifact_id}.json"),
    }
}

fn validate_relative_storage_path(path: &str) -> Result<PathBuf, String> {
    if path.is_empty() || path.contains('\\') || path.starts_with('/') || path.contains('\0') {
        return Err("The verification artifact relative path is invalid.".to_owned());
    }
    let components = path.split('/').collect::<Vec<_>>();
    let valid_shape = match components.as_slice() {
        ["runs", run_id, "baseline", file_name] => {
            validate_id(run_id, "run").is_ok() && validate_artifact_file_name(file_name)
        }
        ["runs", run_id, "attempts", attempt_id, file_name] => {
            validate_id(run_id, "run").is_ok()
                && validate_id(attempt_id, "verification attempt").is_ok()
                && validate_artifact_file_name(file_name)
        }
        _ => false,
    };
    if !valid_shape {
        return Err("The verification artifact relative path is invalid.".to_owned());
    }
    Ok(components.iter().collect())
}

fn validate_artifact_file_name(file_name: &str) -> bool {
    file_name
        .strip_suffix(".json")
        .is_some_and(|artifact_id| validate_id(artifact_id, "artifact").is_ok())
}

fn validate_id(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > MAX_ARTIFACT_ID_BYTES
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(format!("The verification {label} ID is invalid."));
    }
    Ok(())
}

fn canonical_json_bytes_with_limit<T: Serialize>(
    value: &T,
    limit: usize,
) -> Result<Vec<u8>, String> {
    let value = serde_json::to_value(value)
        .map_err(|error| format!("Could not encode verification artifact: {error}"))?;
    let value = canonicalize_json(value);
    let bytes = serde_json::to_vec(&value)
        .map_err(|error| format!("Could not encode verification artifact: {error}"))?;
    if bytes.len() > limit {
        return Err(format!(
            "The verification artifact exceeds the {limit} byte safety limit."
        ));
    }
    Ok(bytes)
}

fn canonicalize_json(value: Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(values.into_iter().map(canonicalize_json).collect()),
        Value::Object(values) => {
            let mut entries = values.into_iter().collect::<Vec<_>>();
            entries.sort_by(|left, right| left.0.cmp(&right.0));
            Value::Object(
                entries
                    .into_iter()
                    .map(|(key, value)| (key, canonicalize_json(value)))
                    .collect(),
            )
        }
        value => value,
    }
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn sha256_hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;

    let digest = Sha256::digest(bytes);
    let mut output = String::with_capacity(digest.len() * 2);
    for byte in digest {
        let _ = write!(output, "{byte:02x}");
    }
    output
}

fn path_is_within(candidate: &Path, root: &Path) -> bool {
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

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "xiao-artifacts-{}",
                crate::runs::repository::new_uuid_v7()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[cfg(windows)]
    struct WindowsJunction(PathBuf);

    #[cfg(windows)]
    impl WindowsJunction {
        fn create(link: PathBuf, target: &Path) -> Self {
            let status = std::process::Command::new("cmd")
                .args(["/d", "/c", "mklink", "/J"])
                .arg(&link)
                .arg(target)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
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

    #[test]
    fn artifact_round_trip_is_canonical_atomic_and_integrity_checked() {
        let directory = TestDirectory::new();
        let store = ArtifactStore::open(&directory.0).unwrap();
        let value = json!({"z": 1, "a": {"z": false, "a": true}});
        let stored = store
            .write_json("run-1", Some("attempt-1"), "artifact-1", &value)
            .unwrap();
        assert_eq!(
            stored.relative_storage_path,
            "runs/run-1/attempts/attempt-1/artifact-1.json"
        );
        let path = store.root.join(&stored.relative_storage_path);
        let bytes = fs::read(&path).unwrap();
        assert_eq!(
            String::from_utf8(bytes).unwrap(),
            r#"{"a":{"a":true,"z":false},"z":1}"#
        );
        assert_eq!(stored.sha256.len(), 64);
        assert_eq!(
            store
                .read_json::<Value>(
                    &stored.relative_storage_path,
                    stored.byte_length,
                    &stored.sha256,
                )
                .unwrap(),
            value
        );
        assert!(store
            .write_json("run-1", Some("attempt-1"), "artifact-1", &value)
            .is_err());
        assert!(fs::read_dir(path.parent().unwrap())
            .unwrap()
            .all(|entry| !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".tmp")));
    }

    #[test]
    fn traversal_tampering_and_oversized_json_fail_closed() {
        let directory = TestDirectory::new();
        let store = ArtifactStore::open(&directory.0).unwrap();
        assert!(store
            .write_json("../run", None, "artifact", &json!({"ok": true}))
            .is_err());
        assert!(store
            .read_json::<Value>("../outside.json", 0, &"0".repeat(64))
            .is_err());
        assert!(canonical_json_bytes_with_limit(&json!({"value": "too large"}), 4).is_err());

        let stored = store
            .write_json("run", None, "baseline", &json!({"ok": true}))
            .unwrap();
        let path = store.root.join(&stored.relative_storage_path);
        fs::write(&path, b"{\"ok\":false}").unwrap();
        assert!(store
            .read_json::<Value>(
                &stored.relative_storage_path,
                stored.byte_length,
                &stored.sha256,
            )
            .is_err());
        assert!(store.remove("runs/run/baseline/baseline.json").is_ok());
        assert!(!path.exists());
        assert!(store.remove("runs/run/baseline/baseline.json").is_ok());
    }

    #[test]
    fn orphan_sweep_reconciles_files_inside_retained_runs() {
        let directory = TestDirectory::new();
        let store = ArtifactStore::open(&directory.0).unwrap();
        let retained_value = json!({"retained": true});
        let retained = store
            .write_json("run-retained", None, "retained", &retained_value)
            .unwrap();
        let stray = store
            .write_json("run-retained", None, "stray", &json!({"stray": true}))
            .unwrap();
        let orphaned = store
            .write_json("run-orphaned", None, "orphaned", &json!({"orphaned": true}))
            .unwrap();
        let retained_path = store.root.join(&retained.relative_storage_path);
        let stray_path = store.root.join(&stray.relative_storage_path);
        let orphaned_path = store.root.join(&orphaned.relative_storage_path);
        let temporary_path = retained_path
            .parent()
            .unwrap()
            .join(".interrupted-publish.tmp");
        fs::write(&temporary_path, b"partial").unwrap();
        let unknown_path = store.root.join("runs").join("operator-note.txt");
        fs::write(&unknown_path, b"preserve").unwrap();

        store
            .reconcile_owned_files(&HashSet::from([retained.relative_storage_path.clone()]))
            .unwrap();

        assert_eq!(
            store
                .read_json::<Value>(
                    &retained.relative_storage_path,
                    retained.byte_length,
                    &retained.sha256,
                )
                .unwrap(),
            retained_value
        );
        assert!(retained_path.is_file());
        assert!(!stray_path.exists());
        assert!(!temporary_path.exists());
        assert!(!orphaned_path.exists());
        assert!(!store.root.join("runs/run-orphaned").exists());
        assert_eq!(fs::read(&unknown_path).unwrap(), b"preserve");
    }

    #[test]
    fn orphan_sweep_rejects_traversal_before_removing_files() {
        let directory = TestDirectory::new();
        let store = ArtifactStore::open(&directory.0).unwrap();
        let stray = store
            .write_json("run", None, "stray", &json!({"stray": true}))
            .unwrap();
        let stray_path = store.root.join(&stray.relative_storage_path);

        assert!(store
            .reconcile_owned_files(&HashSet::from(["../outside.json".to_owned()]))
            .is_err());
        assert!(stray_path.is_file());
    }

    #[test]
    fn orphan_sweep_does_not_follow_links_or_partially_remove_files() {
        let directory = TestDirectory::new();
        let store = ArtifactStore::open(&directory.0).unwrap();
        let stray = store
            .write_json("run", None, "stray", &json!({"stray": true}))
            .unwrap();
        let stray_path = store.root.join(&stray.relative_storage_path);
        let outside_path = directory.0.join("outside.json");
        fs::write(&outside_path, b"outside").unwrap();
        let link_path = stray_path.parent().unwrap().join("linked.json");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside_path, &link_path).unwrap();
        #[cfg(windows)]
        if std::os::windows::fs::symlink_file(&outside_path, &link_path).is_err() {
            return;
        }

        assert!(store.remove("runs/run/baseline/linked.json").is_err());
        assert!(store.reconcile_owned_files(&HashSet::new()).is_err());
        assert!(stray_path.is_file());
        assert_eq!(fs::read(&outside_path).unwrap(), b"outside");
    }

    #[cfg(unix)]
    #[test]
    fn open_rejects_a_linked_artifact_root() {
        let directory = TestDirectory::new();
        let outside = TestDirectory::new();
        let sentinel = outside.0.join("sentinel.txt");
        fs::write(&sentinel, b"outside").unwrap();
        let root = directory.0.join(ARTIFACT_DIRECTORY_NAME);
        std::os::unix::fs::symlink(&outside.0, &root).unwrap();

        assert!(ArtifactStore::open(&directory.0).is_err());
        assert_eq!(fs::read(&sentinel).unwrap(), b"outside");
        fs::remove_file(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn open_rejects_a_windows_junction_artifact_root() {
        let directory = TestDirectory::new();
        let outside = TestDirectory::new();
        let sentinel = outside.0.join("sentinel.txt");
        fs::write(&sentinel, b"outside").unwrap();
        let root = directory.0.join(ARTIFACT_DIRECTORY_NAME);
        let status = std::process::Command::new("cmd")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(&root)
            .arg(&outside.0)
            .status()
            .unwrap();
        if !status.success() {
            return;
        }

        assert!(ArtifactStore::open(&directory.0).is_err());
        assert_eq!(fs::read(&sentinel).unwrap(), b"outside");
        fs::remove_dir(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn write_rejects_windows_junction_components_without_materializing_target_paths() {
        for junction_component in ["runs", "run", "attempts", "attempt"] {
            let directory = TestDirectory::new();
            let store = ArtifactStore::open(&directory.0).unwrap();
            let outside = TestDirectory::new();
            let sentinel = outside.0.join("sentinel.txt");
            fs::write(&sentinel, b"outside sentinel").unwrap();

            let junction_path = match junction_component {
                "runs" => store.root.join("runs"),
                "run" => {
                    fs::create_dir(store.root.join("runs")).unwrap();
                    store.root.join("runs").join("run")
                }
                "attempts" => {
                    fs::create_dir_all(store.root.join("runs").join("run")).unwrap();
                    store.root.join("runs").join("run").join("attempts")
                }
                "attempt" => {
                    fs::create_dir_all(store.root.join("runs").join("run").join("attempts"))
                        .unwrap();
                    store
                        .root
                        .join("runs")
                        .join("run")
                        .join("attempts")
                        .join("attempt")
                }
                _ => unreachable!(),
            };
            let _junction = WindowsJunction::create(junction_path, &outside.0);

            let error = store
                .write_json("run", Some("attempt"), "artifact", &json!({"ok": true}))
                .unwrap_err();

            assert!(error.contains("link or reparse point"), "{error}");
            assert_eq!(fs::read(&sentinel).unwrap(), b"outside sentinel");
            assert_eq!(fs::read_dir(&outside.0).unwrap().count(), 1);
        }
    }

    #[cfg(windows)]
    #[test]
    fn cleanup_rejects_windows_junction_aliases() {
        let directory = TestDirectory::new();
        let store = ArtifactStore::open(&directory.0).unwrap();
        let retained = store
            .write_json("run-retained", None, "retained", &json!({"ok": true}))
            .unwrap();
        let retained_path = store.root.join(&retained.relative_storage_path);
        let retained_run = store.root.join("runs").join("run-retained");
        let alias = store.root.join("runs").join("run-alias");
        let status = std::process::Command::new("cmd")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(&alias)
            .arg(&retained_run)
            .status()
            .unwrap();
        if !status.success() {
            return;
        }

        assert!(store
            .reconcile_owned_files(&HashSet::from([retained.relative_storage_path.clone(),]))
            .is_err());
        assert!(store.remove_run("run-alias").is_err());
        assert!(retained_path.is_file());
        assert_eq!(fs::read(&retained_path).unwrap(), b"{\"ok\":true}");
        fs::remove_dir(&alias).unwrap();
    }
}
