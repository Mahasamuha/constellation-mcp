use crate::config;
use tauri_plugin_autostart::ManagerExt;

#[tauri::command]
pub fn get_config() -> config::NodeConfig {
    config::load_node_config()
}

#[tauri::command]
pub fn get_config_dir() -> String {
    config::config_dir().to_string_lossy().into_owned()
}

#[tauri::command]
pub fn update_tray(app: tauri::AppHandle) {
    crate::refresh_tray(&app);
}

#[tauri::command]
pub fn save_settings(
    app: tauri::AppHandle,
    relay_url: String,
    host: String,
    max_file_size_kb: u32,
) -> Result<(), String> {
    let relay_url = relay_url.trim();
    let host = host.trim();

    let current = config::load_node_config();

    // Rename via CLI only if host actually changed
    let old_host = current.host.as_deref().unwrap_or("");
    if !host.is_empty() && host != old_host {
        crate::cli::run(&["node", "rename", host])?;
    }

    let path = config::config_dir().join("node.yaml");

    // Preserve fields we don't manage (e.g. node_token)
    let mut map = match std::fs::read_to_string(&path) {
        Ok(s) => serde_yaml::from_str::<serde_yaml::Value>(&s)
            .unwrap_or_else(|_| serde_yaml::Value::Mapping(Default::default())),
        Err(_) => serde_yaml::Value::Mapping(Default::default()),
    };

    if let serde_yaml::Value::Mapping(ref mut m) = map {
        if !relay_url.is_empty() {
            m.insert("relay_url".into(), relay_url.into());
        }
        if !host.is_empty() {
            m.insert("host".into(), host.into());
        }
        m.insert("max_file_size_kb".into(), max_file_size_kb.into());
    }

    let content = serde_yaml::to_string(&map).map_err(|e| e.to_string())?;
    config::write_secure(&path, content.as_bytes())?;
    crate::refresh_tray(&app);
    Ok(())
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
