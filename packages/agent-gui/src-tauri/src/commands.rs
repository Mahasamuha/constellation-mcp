use crate::config;

#[tauri::command]
pub fn get_config() -> config::AgentConfig {
    config::load_agent_config()
}

#[tauri::command]
pub fn update_tray(app: tauri::AppHandle) {
    crate::refresh_tray(&app);
}
