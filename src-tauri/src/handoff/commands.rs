use tauri::{AppHandle, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::xiao::repository::XiaoRepository;

use super::models::{
    ExportHandoffRequest, ExportHandoffResult, ImportHandoffRequest, ImportHandoffResult,
};
use super::service::{export_handoff, import_handoff, MAX_ATTACHMENTS};

#[tauri::command]
pub async fn export_xiao_handoff(
    app: AppHandle,
    request: ExportHandoffRequest,
    repository: State<'_, XiaoRepository>,
) -> Result<ExportHandoffResult, String> {
    if request.attachment_paths.len() > MAX_ATTACHMENTS {
        return Err(format!(
            "A handoff can include at most {MAX_ATTACHMENTS} attachments."
        ));
    }
    let attachment_notice = if request.attachment_paths.is_empty() {
        "No attachments are selected.".to_owned()
    } else {
        let paths = request
            .attachment_paths
            .iter()
            .map(|path| {
                path.chars()
                    .map(|character| {
                        if character.is_control() {
                            ' '
                        } else {
                            character
                        }
                    })
                    .take(256)
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n• ");
        format!("Selected attachments are included without redaction:\n• {paths}",)
    };
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .message(format!(
            "Xiao removes common credential patterns and private paths, but automated redaction cannot guarantee that free-form text contains no sensitive data. Review the task before sharing.\n\n{attachment_notice}",
        ))
        .title("Export Xiao handoff?")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Export".to_owned(),
            "Cancel".to_owned(),
        ))
        .show(move |confirmed| {
            let _ = sender.send(confirmed);
        });
    if !receiver.await.unwrap_or(false) {
        return Err("Handoff export cancelled.".to_owned());
    }
    export_handoff(&repository, request)
}

#[tauri::command]
pub fn import_xiao_handoff(
    request: ImportHandoffRequest,
    repository: State<'_, XiaoRepository>,
) -> Result<ImportHandoffResult, String> {
    import_handoff(&repository, request)
}
