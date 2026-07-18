use serde_json::Value;
use std::path::Path;

use tauri::{AppHandle, State};

use super::service::VerificationService;
use crate::execution::service::resolve_execution_context;
use crate::runs::service::RunService;
use crate::xiao::repository::XiaoRepository;

use super::models::{
    AcceptanceContractPreset, AcceptanceContractVersionSummary, AcceptancePresetDiscoveryError,
    AcceptancePresetDiscoveryErrorCode, SaveTaskAcceptanceContractRequest,
    VerificationEvidencePage,
};
use super::presets::discover_acceptance_presets;

#[tauri::command]
pub fn save_xiao_task_acceptance_contract(
    request: SaveTaskAcceptanceContractRequest,
    repository: State<'_, XiaoRepository>,
) -> Result<Option<AcceptanceContractVersionSummary>, String> {
    repository.save_task_acceptance_contract(
        &request.project_path,
        &request.task_id,
        request.expected_current_version_id.as_deref(),
        request.contract.as_ref(),
    )
}

#[tauri::command]
pub fn discover_xiao_acceptance_presets(
    project_path: String,
    task_id: Option<String>,
    repository: State<'_, XiaoRepository>,
) -> Result<Vec<AcceptanceContractPreset>, AcceptancePresetDiscoveryError> {
    discover_acceptance_presets_for_context(&repository, &project_path, task_id.as_deref())
}

fn discovery_task_id(task_id: Option<&str>) -> Option<&str> {
    task_id.filter(|value| !value.trim().is_empty())
}

fn discover_acceptance_presets_for_context(
    repository: &XiaoRepository,
    project_path: &str,
    task_id: Option<&str>,
) -> Result<Vec<AcceptanceContractPreset>, AcceptancePresetDiscoveryError> {
    let context = resolve_execution_context(repository, project_path, discovery_task_id(task_id))
        .map_err(|error| {
        AcceptancePresetDiscoveryError::new(
            AcceptancePresetDiscoveryErrorCode::ExecutionContext,
            error,
        )
    })?;
    discover_acceptance_presets(Path::new(&context.execution_root))
}

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf};

    use uuid::Uuid;

    use super::{discover_acceptance_presets_for_context, discovery_task_id};
    use crate::{
        verification::models::AcceptancePresetDiscoveryErrorCode, xiao::repository::XiaoRepository,
    };

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("xiao-preset-context-{}", Uuid::now_v7(),));
            fs::create_dir_all(root.join("project")).unwrap();
            Self(root)
        }

        fn project(&self) -> PathBuf {
            self.0.join("project")
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn discovery_uses_unbound_context_without_a_persisted_task_id() {
        assert_eq!(discovery_task_id(None), None);
        assert_eq!(discovery_task_id(Some("")), None);
        assert_eq!(discovery_task_id(Some("   ")), None);
    }

    #[test]
    fn unbound_discovery_succeeds_without_a_task_row() {
        let directory = TestDirectory::new();
        let repository = XiaoRepository::open(&directory.0.join("state")).unwrap();
        let project = directory.project();
        let project = project.to_string_lossy();

        assert!(
            discover_acceptance_presets_for_context(&repository, &project, None)
                .unwrap()
                .is_empty()
        );
        assert!(
            discover_acceptance_presets_for_context(&repository, &project, Some(""))
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn discovery_preserves_a_persisted_task_binding() {
        assert_eq!(discovery_task_id(Some("task-123")), Some("task-123"));
        assert_eq!(discovery_task_id(Some(" task-123 ")), Some(" task-123 "));
    }

    #[test]
    fn bound_discovery_still_validates_the_persisted_task() {
        let directory = TestDirectory::new();
        let repository = XiaoRepository::open(&directory.0.join("state")).unwrap();
        let project = directory.project();
        let error = discover_acceptance_presets_for_context(
            &repository,
            &project.to_string_lossy(),
            Some("missing-task"),
        )
        .unwrap_err();

        assert_eq!(
            error.code,
            AcceptancePresetDiscoveryErrorCode::ExecutionContext
        );
    }
}

#[tauri::command]
pub fn rerun_xiao_verification(
    app: AppHandle,
    run_id: String,
    request_key: String,
    service: State<'_, RunService>,
) -> Result<crate::runs::models::RunSnapshot, String> {
    service.rerun_verification(&app, &run_id, &request_key)
}

#[tauri::command]
pub fn list_xiao_verification_evidence(
    run_id: String,
    limit: Option<usize>,
    repository: State<'_, XiaoRepository>,
) -> Result<VerificationEvidencePage, String> {
    repository.list_verification_evidence(&run_id, limit)
}

#[tauri::command]
pub fn read_xiao_verification_artifact(
    app: AppHandle,
    run_id: String,
    artifact_id: String,
    service: State<'_, VerificationService>,
) -> Result<Value, String> {
    service.read_artifact(&app, &run_id, &artifact_id)
}
