use tauri::{AppHandle, Manager, Url, Webview};

const BROWSER_WEBVIEW_LABELS: [&str; 2] = ["xiao-browser", "xiao-game"];

fn browser_webview(app: &AppHandle, label: &str) -> Result<Webview, String> {
    if !BROWSER_WEBVIEW_LABELS.contains(&label) {
        return Err("Unknown Xiao browser.".to_string());
    }

    app.get_webview(label)
        .ok_or_else(|| "The requested Xiao browser is not open.".to_string())
}

fn parse_browser_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value.trim()).map_err(|_| "Enter a valid web address.".to_string())?;
    match url.scheme() {
        "http" | "https" => Ok(url),
        "xiao-preview" if url.host_str() == Some("localhost") => Ok(url),
        _ => Err("Only HTTP and HTTPS pages can open in the Xiao browser.".to_string()),
    }
}

#[tauri::command]
pub fn navigate_browser(app: AppHandle, url: String, label: String) -> Result<(), String> {
    browser_webview(&app, &label)?
        .navigate(parse_browser_url(&url)?)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn go_back_browser(app: AppHandle, label: String) -> Result<(), String> {
    browser_webview(&app, &label)?
        .eval("window.history.back()")
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn go_forward_browser(app: AppHandle, label: String) -> Result<(), String> {
    browser_webview(&app, &label)?
        .eval("window.history.forward()")
        .map_err(|error| error.to_string())
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
    use super::{parse_browser_url, BROWSER_WEBVIEW_LABELS};

    #[test]
    fn accepts_web_urls() {
        assert!(parse_browser_url("https://www.google.com/").is_ok());
        assert!(parse_browser_url("http://localhost:1420/").is_ok());
    }

    #[test]
    fn rejects_privileged_schemes() {
        assert!(parse_browser_url("file:///tmp/private").is_err());
        assert!(parse_browser_url("javascript:alert(1)").is_err());
    }

    #[test]
    fn accepts_xiao_workspace_previews_only_on_the_internal_host() {
        assert!(parse_browser_url("xiao-preview://localhost/token/index.html").is_ok());
        assert!(parse_browser_url("xiao-preview://elsewhere/token/index.html").is_err());
    }

    #[test]
    fn registers_only_xiao_webviews() {
        assert_eq!(BROWSER_WEBVIEW_LABELS, ["xiao-browser", "xiao-game"]);
    }
}
