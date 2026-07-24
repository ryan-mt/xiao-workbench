use tauri::{AppHandle, Manager, State, Url, Webview};

use super::preview::{is_loopback_http_url, is_preview_url, PreviewRegistry, PreviewScope};
use crate::execution::service::resolve_execution_context;
use crate::xiao::repository::XiaoRepository;

const TASK_PREVIEW_LABEL_PREFIX: &str = "xiao-task-preview-";
pub(crate) const PREVIEW_CONSOLE_CAPTURE_SCRIPT: &str = r#"(() => {
  if (!Array.isArray(window.__xiaoPreviewConsole)) {
    window.__xiaoPreviewConsole = [];
    const push = (level, values) => {
      const text = values.map((value) => {
        try { return typeof value === "string" ? value : JSON.stringify(value); }
        catch { return String(value); }
      }).join(" ").slice(0, 4000);
      window.__xiaoPreviewConsole.push({ level, text, at: Date.now() });
      window.__xiaoPreviewConsole = window.__xiaoPreviewConsole.slice(-100);
    };
    for (const level of ["log", "info", "warn", "error", "debug"]) {
      const original = console[level].bind(console);
      console[level] = (...values) => { push(level, values); original(...values); };
    }
    addEventListener("error", (event) => push("error", [event.message]));
    addEventListener("unhandledrejection", (event) => push("error", [event.reason]));
  }
})()"#;
const PREVIEW_CONSOLE_READ_SCRIPT: &str =
    "Array.isArray(window.__xiaoPreviewConsole) ? window.__xiaoPreviewConsole.slice(-100) : []";

fn is_browser_webview_label(label: &str) -> bool {
    label == "xiao-game"
        || label
            .strip_prefix(TASK_PREVIEW_LABEL_PREFIX)
            .is_some_and(|task| {
                !task.is_empty()
                    && task.len() <= 72
                    && task
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
            })
}

fn task_preview_label(project_path: &str, task_id: &str) -> String {
    let mut hash = 14_695_981_039_346_656_037_u64;
    for byte in project_path
        .as_bytes()
        .iter()
        .copied()
        .chain(std::iter::once(0))
        .chain(task_id.as_bytes().iter().copied())
    {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(1_099_511_628_211);
    }
    let safe = task_id
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '-'
            }
        })
        .take(12)
        .collect::<String>();
    format!("{TASK_PREVIEW_LABEL_PREFIX}{hash:016x}-{safe}")
}

fn browser_webview(app: &AppHandle, label: &str) -> Result<Webview, String> {
    if !is_browser_webview_label(label) {
        return Err("Unknown Xiao browser.".to_string());
    }

    app.get_webview(label)
        .ok_or_else(|| "The requested Xiao browser is not open.".to_string())
}

fn parse_browser_url(value: &str, label: &str) -> Result<Url, String> {
    let url = Url::parse(value.trim()).map_err(|_| "Enter a valid web address.".to_string())?;
    if label.starts_with(TASK_PREVIEW_LABEL_PREFIX)
        && !is_preview_url(&url)
        && !is_loopback_http_url(&url)
    {
        return Err(
            "Task Preview only opens host-registered files and local Task outcome servers."
                .to_owned(),
        );
    }
    match url.scheme() {
        "http" | "https" => Ok(url),
        "xiao-preview" if is_preview_url(&url) => Ok(url),
        _ => Err("Only HTTP and HTTPS pages can open in the Xiao browser.".to_string()),
    }
}

#[tauri::command]
pub fn navigate_browser(
    app: AppHandle,
    previews: State<'_, PreviewRegistry>,
    url: String,
    label: String,
    task_id: Option<String>,
    project_path: Option<String>,
    repository: State<'_, XiaoRepository>,
) -> Result<(), String> {
    if label.starts_with(TASK_PREVIEW_LABEL_PREFIX) {
        let task_id = task_id
            .as_deref()
            .ok_or("Task Preview requires a Task binding.")?;
        let project_path = project_path
            .as_deref()
            .ok_or("Task Preview requires a Project binding.")?;
        let context = resolve_execution_context(&repository, project_path, Some(task_id))?;
        let expected = Some(task_preview_label(project_path, task_id));
        let valid = expected.as_deref().is_some_and(|base| {
            label == base
                || label.strip_prefix(base).is_some_and(|suffix| {
                    suffix
                        .strip_prefix("--")
                        .is_some_and(|tab| !tab.is_empty() && tab.len() <= 8)
                })
        });
        if !valid {
            return Err("Task Preview target does not belong to this Task.".to_owned());
        }
        previews.register_task_preview_target(
            &label,
            PreviewScope {
                project_path: context.project_path,
                task_id: task_id.to_owned(),
                execution_root: context.execution_root,
            },
            &Url::parse(url.trim()).map_err(|_| "Enter a valid web address.".to_owned())?,
        )?;
    }
    let url = parse_browser_url(&url, &label)?;
    let webview = browser_webview(&app, &label)?;
    previews.allow_navigation(&label, &url);
    if let Err(error) = webview.navigate(url) {
        previews.clear_navigation_allowance(&label);
        return Err(error.to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn go_back_browser(
    app: AppHandle,
    previews: State<'_, PreviewRegistry>,
    label: String,
) -> Result<(), String> {
    navigate_browser_history(&app, &previews, &label, "window.history.back()")
}

#[tauri::command]
pub fn go_forward_browser(
    app: AppHandle,
    previews: State<'_, PreviewRegistry>,
    label: String,
) -> Result<(), String> {
    navigate_browser_history(&app, &previews, &label, "window.history.forward()")
}

fn navigate_browser_history(
    app: &AppHandle,
    previews: &PreviewRegistry,
    label: &str,
    script: &str,
) -> Result<(), String> {
    let webview = browser_webview(app, label)?;
    previews.allow_history_navigation(label);
    if let Err(error) = webview.eval(script) {
        previews.clear_navigation_allowance(label);
        return Err(error.to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn reload_browser(app: AppHandle, label: String) -> Result<(), String> {
    browser_webview(&app, &label)?
        .reload()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn get_browser_url(app: AppHandle, label: String) -> Result<String, String> {
    browser_webview(&app, &label)?
        .url()
        .map(|url| url.to_string())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn get_browser_console(
    app: AppHandle,
    label: String,
) -> Result<Vec<serde_json::Value>, String> {
    let result = evaluate_webview_script(
        browser_webview(&app, &label)?,
        PREVIEW_CONSOLE_READ_SCRIPT,
        "Timed out reading Task Preview console.",
    )
    .await?;
    serde_json::from_str(&result)
        .map_err(|error| format!("Could not decode Task Preview console: {error}"))
}

fn complete_webview_callback<T>(
    sender: &std::sync::Arc<
        std::sync::Mutex<Option<tokio::sync::oneshot::Sender<Result<T, String>>>>,
    >,
    result: Result<T, String>,
) {
    if let Ok(mut sender) = sender.lock() {
        if let Some(sender) = sender.take() {
            let _ = sender.send(result);
        }
    }
}

async fn evaluate_webview_script(
    webview: Webview,
    script: &str,
    timeout_message: &str,
) -> Result<String, String> {
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    let (sender, receiver) = tokio::sync::oneshot::channel();
    let sender = Arc::new(Mutex::new(Some(sender)));
    #[cfg(target_os = "windows")]
    {
        use webview2_com::ExecuteScriptCompletedHandler;
        use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2;
        use windows::core::HSTRING;

        let script = script.to_owned();
        let callback_sender = Arc::clone(&sender);
        let immediate_sender = Arc::clone(&sender);
        webview
            .with_webview(move |platform| unsafe {
                let result =
                    platform
                        .controller()
                        .CoreWebView2()
                        .and_then(|core: ICoreWebView2| {
                            let script = HSTRING::from(script);
                            core.ExecuteScript(
                                &script,
                                &ExecuteScriptCompletedHandler::create(Box::new(
                                    move |error, result| {
                                        complete_webview_callback(
                                            &callback_sender,
                                            if error.is_ok() {
                                                Ok(result.to_string())
                                            } else {
                                                Err(format!(
                                                    "Task Preview script failed: {error:?}"
                                                ))
                                            },
                                        );
                                        Ok(())
                                    },
                                )),
                            )
                        });
                if let Err(error) = result {
                    complete_webview_callback(&immediate_sender, Err(error.to_string()));
                }
            })
            .map_err(|error| error.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        use webkit2gtk::{JavascriptResultExt, WebViewExt};

        let script = script.to_owned();
        let callback_sender = Arc::clone(&sender);
        webview
            .with_webview(move |platform| {
                platform.inner().run_javascript(
                    &script,
                    None::<&webkit2gtk::gio::Cancellable>,
                    move |result| {
                        let encoded =
                            result
                                .map_err(|error| error.to_string())
                                .and_then(|result| {
                                    result
                                        .js_value()
                                        .and_then(|value| value.to_json(0))
                                        .map(|value| value.to_string())
                                        .map_err(|error| error.to_string())
                                });
                        complete_webview_callback(&callback_sender, encoded);
                    },
                );
            })
            .map_err(|error| error.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        use block2::RcBlock;
        use objc2::{runtime::AnyObject, AllocAnyThread};
        use objc2_foundation::{
            NSError, NSJSONSerialization, NSJSONWritingOptions, NSString, NSUTF8StringEncoding,
        };
        use objc2_web_kit::WKWebView;
        let script = script.to_owned();
        let callback_sender = Arc::clone(&sender);
        webview
            .with_webview(move |platform| unsafe {
                let view: &WKWebView = &*platform.inner().cast();
                let handler = RcBlock::new(move |value: *mut AnyObject, error: *mut NSError| {
                    if !error.is_null() {
                        complete_webview_callback(
                            &callback_sender,
                            Err("Task Preview script failed.".to_owned()),
                        );
                        return;
                    }
                    if value.is_null() {
                        complete_webview_callback(&callback_sender, Ok("null".to_owned()));
                        return;
                    }
                    let result = NSJSONSerialization::dataWithJSONObject_options_error(
                        &*value,
                        NSJSONWritingOptions::FragmentsAllowed,
                    )
                    .and_then(|data| {
                        NSString::initWithData_encoding(
                            NSString::alloc(),
                            &data,
                            NSUTF8StringEncoding,
                        )
                    })
                    .map(|value| value.to_string())
                    .ok_or_else(|| "Could not encode Task Preview script result.".to_owned());
                    complete_webview_callback(&callback_sender, result);
                });
                view.evaluateJavaScript_completionHandler(
                    &NSString::from_str(&script),
                    Some(&handler),
                );
            })
            .map_err(|error| error.to_string())?;
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    {
        let _ = (webview, script, sender);
        return Err("Task Preview script execution is unavailable on this platform.".to_owned());
    }
    tokio::time::timeout(Duration::from_secs(2), receiver)
        .await
        .map_err(|_| timeout_message.to_owned())?
        .map_err(|_| "Task Preview closed before the script completed.".to_owned())?
}

#[tauri::command]
pub async fn automate_task_preview(
    app: AppHandle,
    previews: State<'_, PreviewRegistry>,
    repository: State<'_, XiaoRepository>,
    label: String,
    project_path: String,
    task_id: String,
    action: String,
    selector: String,
    value: Option<String>,
) -> Result<(), String> {
    let context = resolve_execution_context(&repository, &project_path, Some(&task_id))?;
    automate_preview(
        &app,
        &previews,
        &PreviewScope {
            project_path: context.project_path,
            task_id,
            execution_root: context.execution_root,
        },
        &label,
        &action,
        &selector,
        value.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn capture_task_preview(
    app: AppHandle,
    previews: State<'_, PreviewRegistry>,
    repository: State<'_, XiaoRepository>,
    label: String,
    project_path: String,
    task_id: String,
) -> Result<String, String> {
    let context = resolve_execution_context(&repository, &project_path, Some(&task_id))?;
    let scope = PreviewScope {
        project_path: context.project_path,
        task_id,
        execution_root: context.execution_root,
    };
    if !previews.task_preview_scope_matches(&label, &scope) {
        return Err("Task Preview evidence does not belong to this Task.".to_owned());
    }
    let evidence_root = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("preview-evidence");
    std::fs::create_dir_all(&evidence_root).map_err(|error| error.to_string())?;
    let evidence_path = evidence_root.join(format!("{}.png", uuid::Uuid::now_v7()));
    capture_preview_image(browser_webview(&app, &label)?, &evidence_path).await?;
    Ok(evidence_path.to_string_lossy().into_owned())
}

#[cfg(target_os = "windows")]
async fn capture_preview_image(webview: Webview, path: &std::path::Path) -> Result<(), String> {
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    use webview2_com::CapturePreviewCompletedHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2, COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
    };
    use windows::core::HSTRING;
    use windows::Win32::System::Com::{STGM_CREATE, STGM_SHARE_EXCLUSIVE, STGM_WRITE};
    use windows::Win32::UI::Shell::SHCreateStreamOnFileEx;

    let path = path.to_path_buf();
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let sender = Arc::new(Mutex::new(Some(sender)));
    let callback_sender = Arc::clone(&sender);
    let immediate_sender = Arc::clone(&sender);
    webview
        .with_webview(move |platform| unsafe {
            let result = (|| {
                let core: ICoreWebView2 = platform.controller().CoreWebView2()?;
                let path = HSTRING::from(path.as_os_str());
                let stream = SHCreateStreamOnFileEx(
                    &path,
                    (STGM_CREATE | STGM_WRITE | STGM_SHARE_EXCLUSIVE).0,
                    0,
                    true,
                    None,
                )?;
                core.CapturePreview(
                    COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
                    &stream,
                    &CapturePreviewCompletedHandler::create(Box::new(move |error| {
                        complete_webview_callback(
                            &callback_sender,
                            error.map_err(|error| error.to_string()),
                        );
                        Ok(())
                    })),
                )
            })();
            if let Err(error) = result {
                complete_webview_callback(&immediate_sender, Err(error.to_string()));
            }
        })
        .map_err(|error| error.to_string())?;
    tokio::time::timeout(Duration::from_secs(5), receiver)
        .await
        .map_err(|_| "Timed out capturing Task Preview evidence.".to_owned())?
        .map_err(|_| "Task Preview closed before evidence capture completed.".to_owned())?
}

#[cfg(target_os = "linux")]
async fn capture_preview_image(webview: Webview, path: &std::path::Path) -> Result<(), String> {
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    use webkit2gtk::{SnapshotOptions, SnapshotRegion, WebViewExt};

    let path = path.to_path_buf();
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let sender = Arc::new(Mutex::new(Some(sender)));
    let callback_sender = Arc::clone(&sender);
    webview
        .with_webview(move |platform| {
            platform.inner().snapshot(
                SnapshotRegion::Visible,
                SnapshotOptions::NONE,
                None::<&webkit2gtk::gio::Cancellable>,
                move |result| {
                    let encoded = result
                        .map_err(|error| error.to_string())
                        .and_then(|surface| {
                            let mut file =
                                std::fs::File::create(&path).map_err(|error| error.to_string())?;
                            surface
                                .write_to_png(&mut file)
                                .map_err(|error| error.to_string())
                        });
                    complete_webview_callback(&callback_sender, encoded);
                },
            );
        })
        .map_err(|error| error.to_string())?;
    tokio::time::timeout(Duration::from_secs(5), receiver)
        .await
        .map_err(|_| "Timed out capturing Task Preview evidence.".to_owned())?
        .map_err(|_| "Task Preview closed before evidence capture completed.".to_owned())?
}

#[cfg(not(any(target_os = "windows", target_os = "linux")))]
async fn capture_preview_image(_webview: Webview, _path: &std::path::Path) -> Result<(), String> {
    Err("Task Preview screenshot evidence is unavailable on this platform.".to_owned())
}

async fn automate_preview(
    app: &AppHandle,
    previews: &PreviewRegistry,
    scope: &PreviewScope,
    label: &str,
    action: &str,
    selector: &str,
    value: Option<&str>,
) -> Result<(), String> {
    let script = preview_automation_script(previews, scope, label, action, selector, value)?;
    let result = evaluate_webview_script(
        browser_webview(app, label)?,
        &script,
        "Timed out automating Task Preview.",
    )
    .await?;
    let result: serde_json::Value = serde_json::from_str(&result)
        .map_err(|error| format!("Could not decode Task Preview automation result: {error}"))?;
    if result.get("ok").and_then(serde_json::Value::as_bool) == Some(true) {
        return Ok(());
    }
    Err(result
        .get("error")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("Task Preview automation failed.")
        .to_owned())
}

fn preview_automation_script(
    previews: &PreviewRegistry,
    scope: &PreviewScope,
    label: &str,
    action: &str,
    selector: &str,
    value: Option<&str>,
) -> Result<String, String> {
    if selector.trim().is_empty() || selector.len() > 500 {
        return Err("Task Preview automation requires a bounded selector.".to_owned());
    }
    if value.is_some_and(|value| value.len() > 2_000) {
        return Err("Task Preview automation value is too large.".to_owned());
    }
    if !matches!(action, "click" | "focus" | "fill") {
        return Err("Task Preview automation supports click, focus, or fill.".to_owned());
    }
    if !previews.task_preview_scope_matches(label, scope) {
        return Err("Task Preview automation does not belong to this Task.".to_owned());
    }
    let selector = serde_json::to_string(selector.trim()).map_err(|error| error.to_string())?;
    let value =
        serde_json::to_string(value.unwrap_or_default()).map_err(|error| error.to_string())?;
    let operation = match action {
        "click" => "element.click();",
        "focus" => "element.focus();",
        "fill" => "element.focus(); element.value = value; element.dispatchEvent(new Event('input', { bubbles: true }));",
        _ => unreachable!(),
    };
    Ok(format!(
        "(() => {{ try {{ const element = document.querySelector({selector}); if (!element) return {{ ok: false, error: 'Selector not found' }}; const value = {value}; {operation} return {{ ok: true }}; }} catch (error) {{ return {{ ok: false, error: String(error instanceof Error ? error.message : error) }}; }} }})()"
    ))
}

pub(crate) async fn execute_codex_preview_tool(
    app: &AppHandle,
    previews: &PreviewRegistry,
    scope: PreviewScope,
    tool: &str,
    arguments: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let arguments = arguments
        .as_object()
        .ok_or("Task Preview tool arguments must be an object.")?;
    match tool {
        "targets" => {
            if !arguments.is_empty() {
                return Err("Task Preview targets does not accept arguments.".to_owned());
            }
            let targets = previews
                .task_preview_targets(&scope)
                .into_iter()
                .map(|(label, origins)| serde_json::json!({ "label": label, "origins": origins }))
                .collect::<Vec<_>>();
            Ok(serde_json::json!({ "targets": targets }))
        }
        "automate" => {
            if arguments
                .keys()
                .any(|key| !matches!(key.as_str(), "label" | "action" | "selector" | "value"))
            {
                return Err("Task Preview automation received an unknown argument.".to_owned());
            }
            let label = arguments
                .get("label")
                .and_then(serde_json::Value::as_str)
                .ok_or("Task Preview automation requires a label.")?;
            let action = arguments
                .get("action")
                .and_then(serde_json::Value::as_str)
                .ok_or("Task Preview automation requires an action.")?;
            let selector = arguments
                .get("selector")
                .and_then(serde_json::Value::as_str)
                .ok_or("Task Preview automation requires a selector.")?;
            let value = arguments.get("value").and_then(serde_json::Value::as_str);
            automate_preview(app, previews, &scope, label, action, selector, value).await?;
            Ok(serde_json::json!({ "performed": true }))
        }
        _ => Err(format!("Unknown Xiao Task Preview tool `{tool}`.")),
    }
}

#[tauri::command]
pub fn set_browser_muted(app: AppHandle, label: String, muted: bool) -> Result<(), String> {
    let webview = browser_webview(&app, &label)?;

    #[cfg(target_os = "windows")]
    {
        webview
            .with_webview(move |platform| unsafe {
                use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_8;
                use windows::core::Interface;

                if let Ok(core) = platform.controller().CoreWebView2() {
                    if let Ok(core) = core.cast::<ICoreWebView2_8>() {
                        let _ = core.SetIsMuted(muted);
                    }
                }
            })
            .map_err(|error| error.to_string())?;
    }

    #[cfg(target_os = "linux")]
    {
        webview
            .with_webview(move |platform| {
                use webkit2gtk::WebViewExt;
                platform.inner().set_is_muted(muted);
            })
            .map_err(|error| error.to_string())?;
    }

    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    webview
        .eval(&format!(
            "document.querySelectorAll('audio,video').forEach((media) => media.muted = {});",
            if muted { "true" } else { "false" }
        ))
        .map_err(|error| error.to_string())?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{is_browser_webview_label, parse_browser_url, preview_automation_script};
    use crate::browser::preview::{PreviewRegistry, PreviewScope};
    use tauri::Url;

    #[test]
    fn accepts_web_urls() {
        assert!(parse_browser_url("https://www.google.com/", "xiao-game").is_ok());
        assert!(parse_browser_url("http://localhost:1420/", "xiao-task-preview-task").is_ok());
        assert!(parse_browser_url("https://www.google.com/", "xiao-task-preview-task").is_err());
    }

    #[test]
    fn rejects_privileged_schemes() {
        assert!(parse_browser_url("file:///tmp/private", "xiao-game").is_err());
        assert!(parse_browser_url("javascript:alert(1)", "xiao-game").is_err());
    }

    #[test]
    fn accepts_xiao_workspace_previews_only_on_token_origins() {
        assert!(parse_browser_url(
            "xiao-preview://018f47a2-a9b3-7c11-8c52-cc14251c6789/index.html",
            "xiao-task-preview-task",
        )
        .is_ok());
        assert!(parse_browser_url(
            "xiao-preview://localhost/index.html",
            "xiao-task-preview-task"
        )
        .is_err());
    }

    #[test]
    fn registers_only_task_scoped_preview_and_game_webviews() {
        assert!(is_browser_webview_label("xiao-task-preview-task-1"));
        assert!(is_browser_webview_label("xiao-game"));
        assert!(!is_browser_webview_label("xiao-browser"));
        assert!(!is_browser_webview_label("xiao-task-preview-../main"));
    }

    #[test]
    fn codex_preview_automation_rejects_a_cross_task_label() {
        let registry = PreviewRegistry::default();
        let task_a = PreviewScope {
            project_path: "C:/project".to_owned(),
            task_id: "task-a".to_owned(),
            execution_root: "C:/worktree-a".to_owned(),
        };
        registry
            .register_task_preview_target(
                "xiao-task-preview-task-a",
                task_a.clone(),
                &Url::parse("http://127.0.0.1:4101/").unwrap(),
            )
            .unwrap();
        let task_b = PreviewScope {
            project_path: "C:/project".to_owned(),
            task_id: "task-b".to_owned(),
            execution_root: "C:/worktree-b".to_owned(),
        };

        let script = preview_automation_script(
            &registry,
            &task_a,
            "xiao-task-preview-task-a",
            "click",
            "#submit",
            None,
        )
        .unwrap();
        assert!(script.contains("return { ok: true }"));
        assert!(script.contains("Selector not found"));
        assert!(preview_automation_script(
            &registry,
            &task_b,
            "xiao-task-preview-task-a",
            "click",
            "#submit",
            None,
        )
        .is_err());
    }
}
