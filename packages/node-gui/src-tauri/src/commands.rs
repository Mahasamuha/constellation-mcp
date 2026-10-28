use crate::config;
use tauri_plugin_autostart::ManagerExt;

#[tauri::command]
pub fn get_config() -> config::RendererNodeConfig {
    config::RendererNodeConfig::from(&config::load_node_config())
}

#[tauri::command]
pub fn get_config_dir() -> String {
    config::config_dir().to_string_lossy().into_owned()
}

#[tauri::command]
pub fn update_tray(app: tauri::AppHandle) {
    crate::refresh_tray(&app);
}

/// What `save_settings` tells the window.
#[derive(Debug, serde::Serialize)]
pub struct SaveOutcome {
    /// The relay moved to a different origin, so the CLI removed the node token (it was issued by
    /// the old relay and must not be sent to the new one). The node must register again.
    pub credentials_dropped: bool,
}

/// The `{"ok":true,"credentials_dropped":bool}` line `constellation node config set --json` prints.
#[derive(Debug, serde::Deserialize)]
struct ConfigSetResult {
    credentials_dropped: bool,
}

fn parse_config_set(stdout: &str) -> Result<ConfigSetResult, String> {
    serde_json::from_str(stdout.trim()).map_err(|e| format!("Unexpected CLI output: {e}"))
}

#[tauri::command]
pub fn save_settings(
    app: tauri::AppHandle,
    relay_url: String,
    host: String,
    max_file_size_kb: u32,
) -> Result<SaveOutcome, String> {
    let relay_url = relay_url.trim();
    let host = host.trim();

    let current = config::load_node_config();

    // Rename via CLI only if host actually changed
    let old_host = current.host.as_deref().unwrap_or("");
    if !host.is_empty() && host != old_host {
        crate::cli::run(&["node", "rename", host])?;
    }

    // Everything else is written by the CLI too — node-gui never touches node.yaml
    // directly, so there's exactly one implementation of "persist node config safely".
    let max_file_size_kb_str = max_file_size_kb.to_string();
    let mut args = vec!["node", "config", "set", "--json", "--max-file-size-kb", &max_file_size_kb_str];
    if !relay_url.is_empty() {
        args.push("--relay-url");
        args.push(relay_url);
    }
    let result = parse_config_set(&crate::cli::output(&args)?)?;

    crate::refresh_tray(&app);
    Ok(SaveOutcome { credentials_dropped: result.credentials_dropped })
}

#[tauri::command]
pub fn get_autostart(app: tauri::AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
pub fn set_autostart(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    if enabled {
        app.autolaunch().enable().map_err(|e| e.to_string())
    } else {
        app.autolaunch().disable().map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_config_set_json() {
        assert!(parse_config_set("{\"ok\":true,\"credentials_dropped\":true}\n").unwrap().credentials_dropped);
        assert!(!parse_config_set("{\"ok\":true,\"credentials_dropped\":false}").unwrap().credentials_dropped);
        assert!(parse_config_set("Config updated.").is_err());
    }
}
