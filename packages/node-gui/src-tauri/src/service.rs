use serde_json::Value;
use tauri::AppHandle;

use crate::config;

pub struct NodeStatusInfo {
    pub service: String,
    pub path_count: usize,
}

pub fn query_status_info() -> NodeStatusInfo {
    crate::cli::output(&["node", "status", "--json"])
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .map(|v| NodeStatusInfo {
            service: v["service"].as_str().unwrap_or("unknown").to_string(),
            path_count: v["shares"].as_array().map(|a| a.len()).unwrap_or(0),
        })
        .unwrap_or_else(|| NodeStatusInfo {
            service: "unknown".to_string(),
            path_count: 0,
        })
}

#[derive(Debug, serde::Serialize)]
pub struct NodeRelayInfo {
    pub connected: bool,
    pub last_heartbeat_at: Option<String>,
    pub last_disconnect_reason: Option<String>,
    pub registered_at: Option<String>,
    pub token_last_used_at: Option<String>,
}

#[tauri::command]
pub fn get_node_relay_info() -> Option<NodeRelayInfo> {
    let host = crate::config::load_node_config().host?;
    let json = crate::cli::output(&["relay", "executors", "list", "--json"]).ok()?;
    let executors: Vec<Value> = serde_json::from_str(&json).ok()?;
    let executor = executors.into_iter().find(|e| e["host"].as_str() == Some(host.as_str()))?;
    Some(NodeRelayInfo {
        connected: executor["connected"].as_bool().unwrap_or(false),
        last_heartbeat_at: executor["last_heartbeat_at"].as_str().map(String::from),
        last_disconnect_reason: executor["last_disconnect_reason"].as_str().map(String::from),
        registered_at: executor["registered_at"].as_str().map(String::from),
        token_last_used_at: executor["token_last_used_at"].as_str().map(String::from),
    })
}

#[tauri::command]
pub async fn rotate_token(app: AppHandle) -> Result<(), String> {
    crate::cli::run(&["node", "rotate"])?;
    crate::refresh_tray(&app);
    crate::notify(&app, "Constellation", "Node token rotated successfully.");
    Ok(())
}

#[tauri::command]
pub fn deregister_node(app: AppHandle) -> Result<(), String> {
    let host = config::load_node_config().host;
    let was_active = query_status_info().service == "active";

    // Stop the daemon before deleting its config — otherwise it keeps running with
    // the token already in memory and silently reconnects, even though node-gui and
    // the relay both now think it's gone. Only treat a stop failure as fatal if the
    // service was actually running; a never-installed/already-stopped service can
    // fail `node stop` for reasons that don't matter here, since nothing was running.
    if let Err(e) = crate::cli::run(&["node", "stop"]) {
        if was_active {
            return Err(e);
        }
    }

    // Best-effort: also revoke the token server-side, so the relay stops trusting it
    // even if some other copy of the credential survives. Requires a separate
    // OAuth-authenticated `relay login` session that not every node owner has set up
    // — skip silently if unavailable, the same fallback get_node_relay_info uses.
    if let Some(host) = host {
        if let Ok(json) = crate::cli::output(&["relay", "executors", "list", "--json"]) {
            if let Ok(executors) = serde_json::from_str::<Vec<Value>>(&json) {
                if let Some(id) = executors
                    .iter()
                    .find(|e| e["host"].as_str() == Some(host.as_str()))
                    .and_then(|e| e["id"].as_str())
                {
                    let _ = crate::cli::run(&["relay", "executors", "revoke", id]);
                }
            }
        }
    }

    let path = config::config_dir().join("node.yaml");
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    crate::refresh_tray(&app);
    Ok(())
}

#[tauri::command]
pub fn get_service_status() -> String {
    crate::cli::output(&["node", "status", "--json"])
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v["service"].as_str().map(str::to_string))
        .unwrap_or_else(|| "unknown".to_string())
}

#[tauri::command]
pub fn start_node() -> Result<(), String> {
    crate::cli::run(&["node", "start"])
}

#[tauri::command]
pub fn stop_node() -> Result<(), String> {
    crate::cli::run(&["node", "stop"])
}

#[tauri::command]
pub fn restart_node() -> Result<(), String> {
    crate::cli::run(&["node", "restart"])
}

#[tauri::command]
pub async fn get_logs(lines: u32) -> Result<String, String> {
    crate::cli::output(&["node", "logs", "--lines", &lines.to_string()])
}
