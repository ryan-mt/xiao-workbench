mod agent;
mod browser;
pub mod companion;
mod execution;
mod git;
mod handoff;
mod lsp;
mod process;
mod routines;
mod runs;
mod system;
mod terminal;
mod time_travel;
mod verification;
mod workspace;
mod xiao;

use agent::commands::{
    agent_request, list_agent_models, read_agent_account, read_agent_rate_limits, read_agent_usage,
    read_codex_rollout_commands, start_agent_runtime, stop_agent_runtime,
};
use agent::runtime::EnvironmentRuntimeRegistry;
use browser::commands::{
    automate_task_preview, capture_task_preview, get_browser_console, get_browser_url,
    go_back_browser, go_forward_browser, navigate_browser, open_external_url, reload_browser,
    set_browser_muted, PREVIEW_CONSOLE_CAPTURE_SCRIPT,
};
use browser::preview::PreviewRegistry;
use companion::adapter::{
    start_runtime_outbox_reconciler, AppCompanionApi, CompanionExecutionGate,
};
use companion::commands::{
    confirm_remote_companion, execute_remote_companion_command, forget_remote_companion,
    install_remote_companion_rotation, issue_companion_pairing_bundle, list_companion_audit,
    list_companion_sessions, pair_remote_companion, poll_remote_companion,
    poll_remote_companion_notifications, replace_companion_session_grants, revoke_companion_device,
    revoke_companion_session, rotate_companion_session,
};
use companion::transport::client::{CompanionPinnedClient, KeyringCredentialStore};
use companion::transport::router::companion_router;
use companion::transport::server::CompanionHttpsServer;
use companion::transport::{discover_lan_bind_address, CompanionHostRuntime, TransportIdentity};
use execution::commands::{
    get_xiao_execution_context, list_xiao_managed_worktrees, prepare_xiao_managed_worktree,
    remove_xiao_managed_worktree,
};
use git::commands::{
    add_git_worktree, apply_git_patch, compare_git_branch, create_git_checkpoint,
    create_git_draft_pull_request, discard_git_checkpoint, finish_git_checkpoint, get_git_branches,
    get_git_pull_request, get_git_pull_request_checks, get_git_worktrees, mutate_git,
    publish_git_branch,
};
use handoff::commands::{export_xiao_handoff, import_xiao_handoff};
use lsp::LspManager;
use routines::commands::{
    create_xiao_routine, delete_xiao_routine, list_xiao_routines, run_xiao_routine_now,
    set_xiao_routine_enabled, update_xiao_routine,
};
use routines::service::RoutineService;
use runs::commands::{
    cancel_xiao_run, enqueue_xiao_run, list_xiao_pending_inputs, list_xiao_runs,
    load_xiao_run_events, resolve_xiao_run_input, retry_xiao_run, steer_xiao_run,
};
use runs::service::RunService;
use system::commands::{check_codex_update, get_system_info, update_codex_cli};
use terminal::commands::{resize_terminal, start_terminal, stop_terminal, write_terminal};
use terminal::runtime::TerminalManager;
use time_travel::commands::{list_xiao_turn_checkpoints, restore_xiao_turns};
use verification::commands::{
    discover_xiao_acceptance_presets, list_xiao_verification_evidence,
    read_xiao_verification_artifact, rerun_xiao_verification, save_xiao_task_acceptance_contract,
};
use verification::service::VerificationService;
use workspace::commands::{
    get_workspace_snapshot, list_workspace_files, open_workspace_preview, read_workspace_file,
};
use xiao::commands::{
    acknowledge_xiao_attention_item, bind_xiao_task_codex_profile, delete_xiao_codex_profile,
    delete_xiao_project_group, list_xiao_attention_items, list_xiao_codex_profiles,
    list_xiao_project_groups, list_xiao_projects, list_xiao_task_publications,
    list_xiao_task_stage_transitions, load_xiao_timeline_page, load_xiao_workspace,
    open_xiao_project, reorder_xiao_project_groups, save_xiao_codex_profile,
    save_xiao_project_group, save_xiao_workspace, search_xiao_history, search_xiao_history_global,
    transition_xiao_task_stage, update_xiao_project_presentation,
};
use xiao::repository::XiaoRepository;

use std::sync::Arc;
use tauri::Manager;

pub fn run_runtime_supervisor_if_requested() -> Option<i32> {
    process::run_if_requested()
}

fn install_process_crypto_provider() -> Result<(), String> {
    rustls::crypto::aws_lc_rs::default_provider()
        .install_default()
        .map_err(|_| {
            "A Rustls crypto provider was installed before Xiao initialized TLS.".to_owned()
        })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    install_process_crypto_provider().expect("failed to install Xiao's TLS crypto provider");
    let preview_registry = PreviewRegistry::default();
    let protocol_previews = preview_registry.clone();
    let preview_navigation = preview_registry.clone();
    let builder = tauri::Builder::default()
        .register_uri_scheme_protocol("xiao-preview", move |_context, request| {
            protocol_previews.respond(&request)
        })
        .plugin(
            tauri::plugin::Builder::<tauri::Wry, ()>::new("preview-navigation")
                .js_init_script(PREVIEW_CONSOLE_CAPTURE_SCRIPT)
                .on_navigation(move |webview, target| {
                    let Ok(current) = webview.url() else {
                        return true;
                    };
                    preview_navigation.navigation_allowed(webview.label(), &current, target)
                })
                .build(),
        );
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    }));

    builder
        .plugin(tauri_plugin_dialog::init())
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            #[cfg(debug_assertions)]
            let app_data_dir = match std::env::var_os("XIAO_WORKBENCH_STATE_DIR") {
                Some(path) => {
                    let path = std::path::PathBuf::from(path);
                    if !path.is_absolute() {
                        return Err("XIAO_WORKBENCH_STATE_DIR must be an absolute path.".into());
                    }
                    path
                }
                None => app_data_dir,
            };
            app.manage(XiaoRepository::initialize(app_data_dir.clone()));
            app.manage(EnvironmentRuntimeRegistry::default());
            app.manage(LspManager::default());
            app.manage(RunService::default());
            app.manage(VerificationService::default());
            app.manage(RoutineService::default());
            app.manage(CompanionPinnedClient::new(Arc::new(KeyringCredentialStore)));
            app.manage(CompanionExecutionGate::default());
            let companion_runtime = match discover_lan_bind_address(4318).and_then(|bind| {
                let endpoint = format!("https://{bind}");
                let identity = TransportIdentity::load_or_create(
                    &app_data_dir,
                    endpoint,
                    "xiao-companion.local".to_owned(),
                )?;
                let router = companion_router(Arc::new(AppCompanionApi::new(app.handle().clone())));
                let server = tauri::async_runtime::block_on(CompanionHttpsServer::start(
                    bind, &identity, router,
                ))?;
                Ok(CompanionHostRuntime::available(identity, server))
            }) {
                Ok(runtime) => runtime,
                Err(reason) => CompanionHostRuntime::unavailable(reason),
            };
            app.manage(companion_runtime);
            #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
            routines::service::configure_tray(app)?;
            app.state::<RunService>().start(app.handle().clone());
            app.state::<RoutineService>().start(app.handle().clone());
            start_runtime_outbox_reconciler(app.handle().clone());
            Ok(())
        })
        .manage(TerminalManager::default())
        .manage(preview_registry)
        .invoke_handler(tauri::generate_handler![
            get_workspace_snapshot,
            get_xiao_execution_context,
            prepare_xiao_managed_worktree,
            list_xiao_managed_worktrees,
            remove_xiao_managed_worktree,
            list_workspace_files,
            read_workspace_file,
            open_workspace_preview,
            get_system_info,
            check_codex_update,
            update_codex_cli,
            start_agent_runtime,
            stop_agent_runtime,
            agent_request,
            read_codex_rollout_commands,
            read_agent_account,
            read_agent_rate_limits,
            read_agent_usage,
            list_agent_models,
            enqueue_xiao_run,
            steer_xiao_run,
            list_xiao_runs,
            list_xiao_pending_inputs,
            load_xiao_run_events,
            cancel_xiao_run,
            retry_xiao_run,
            resolve_xiao_run_input,
            create_xiao_routine,
            update_xiao_routine,
            list_xiao_routines,
            set_xiao_routine_enabled,
            run_xiao_routine_now,
            delete_xiao_routine,
            save_xiao_task_acceptance_contract,
            rerun_xiao_verification,
            list_xiao_verification_evidence,
            read_xiao_verification_artifact,
            discover_xiao_acceptance_presets,
            mutate_git,
            get_git_branches,
            compare_git_branch,
            get_git_worktrees,
            publish_git_branch,
            get_git_pull_request,
            create_git_draft_pull_request,
            get_git_pull_request_checks,
            add_git_worktree,
            apply_git_patch,
            create_git_checkpoint,
            finish_git_checkpoint,
            discard_git_checkpoint,
            list_xiao_turn_checkpoints,
            restore_xiao_turns,
            export_xiao_handoff,
            import_xiao_handoff,
            start_terminal,
            write_terminal,
            resize_terminal,
            stop_terminal,
            navigate_browser,
            open_external_url,
            go_back_browser,
            go_forward_browser,
            reload_browser,
            get_browser_url,
            get_browser_console,
            automate_task_preview,
            capture_task_preview,
            set_browser_muted,
            issue_companion_pairing_bundle,
            list_companion_sessions,
            rotate_companion_session,
            revoke_companion_session,
            revoke_companion_device,
            replace_companion_session_grants,
            list_companion_audit,
            pair_remote_companion,
            poll_remote_companion,
            confirm_remote_companion,
            poll_remote_companion_notifications,
            execute_remote_companion_command,
            install_remote_companion_rotation,
            forget_remote_companion,
            load_xiao_workspace,
            load_xiao_timeline_page,
            search_xiao_history,
            search_xiao_history_global,
            save_xiao_workspace,
            list_xiao_projects,
            save_xiao_project_group,
            list_xiao_project_groups,
            reorder_xiao_project_groups,
            delete_xiao_project_group,
            update_xiao_project_presentation,
            save_xiao_codex_profile,
            list_xiao_codex_profiles,
            delete_xiao_codex_profile,
            bind_xiao_task_codex_profile,
            transition_xiao_task_stage,
            list_xiao_task_stage_transitions,
            list_xiao_attention_items,
            acknowledge_xiao_attention_item,
            list_xiao_task_publications,
            open_xiao_project,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Xiao Workbench");
}

#[cfg(test)]
mod tests {
    use super::install_process_crypto_provider;

    #[test]
    fn runtime_installs_crypto_provider_before_tls_configuration() {
        install_process_crypto_provider().expect("crypto provider");
        assert!(rustls::crypto::CryptoProvider::get_default().is_some());
        let _ = rustls::ServerConfig::builder();
    }
}
