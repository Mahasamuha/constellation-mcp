use serde_json::Value;
use tauri::AppHandle;

use crate::config;

pub struct AgentStatusInfo {
    pub service: String,
    pub path_count: usize,
}

pub fn query_status_info() -> AgentStatusInfo {
    crate::cli::output(&["agent", "status", "--json"])
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .map(|v| AgentStatusInfo {
            service: v["service"].as_str().unwrap_or("unknown").to_string(),
            path_count: v["labels"].as_array().map(|a| a.len()).unwrap_or(0),
        })
        .unwrap_or_else(|| AgentStatusInfo {
            service: "unknown".to_string(),
            path_count: 0,
        })
}

#[tauri::command]
pub async fn rotate_token(app: AppHandle) -> Result<(), String> {
    crate::cli::run(&["agent", "rotate"])?;
    crate::refresh_tray(&app);
    Ok(())
}

#[tauri::command]
pub fn deregister_agent(app: AppHandle) -> Result<(), String> {
    let path = config::config_dir().join("agent.yaml");
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    crate::refresh_tray(&app);
    Ok(())
}

#[tauri::command]
pub fn get_service_status() -> String {
    crate::cli::output(&["agent", "status", "--json"])
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v["service"].as_str().map(str::to_string))
        .unwrap_or_else(|| "unknown".to_string())
}

#[tauri::command]
pub fn start_agent() -> Result<(), String> {
    crate::cli::run(&["agent", "start"])
}

#[tauri::command]
pub fn stop_agent() -> Result<(), String> {
    crate::cli::run(&["agent", "stop"])
}

#[tauri::command]
pub fn restart_agent() -> Result<(), String> {
    crate::cli::run(&["agent", "restart"])
}

#[tauri::command]
pub async fn get_logs(lines: u32) -> Result<String, String> {
    crate::cli::output(&["agent", "logs", "--lines", &lines.to_string()])
}
