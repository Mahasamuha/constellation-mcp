use serde::{Deserialize, Serialize};
use std::process::Command;

use crate::config;

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct PathEntry {
    pub label: String,
    pub path: String,
}

#[derive(Debug, Deserialize, Serialize, Default)]
struct PathsFile {
    paths: Vec<PathEntry>,
}

fn load_paths() -> Vec<PathEntry> {
    let file = config::config_dir().join("paths.yaml");
    match std::fs::read_to_string(file) {
        Ok(content) => serde_yaml::from_str::<PathsFile>(&content)
            .unwrap_or_default()
            .paths,
        Err(_) => vec![],
    }
}

fn run_cli(args: &[&str]) -> Result<(), String> {
    let output = Command::new("constellation")
        .args(args)
        .output()
        .map_err(|e| format!("Could not run constellation CLI: {e}"))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            format!("constellation {} failed (exit {})", args.join(" "), output.status)
        } else {
            stderr
        })
    }
}

#[tauri::command]
pub fn get_paths() -> Vec<PathEntry> {
    load_paths()
}

#[tauri::command]
pub async fn add_path(label: String, path: String) -> Result<Vec<PathEntry>, String> {
    run_cli(&["agent", "paths", "add", &label, &path])?;
    Ok(load_paths())
}

#[tauri::command]
pub async fn remove_path(label: String) -> Result<Vec<PathEntry>, String> {
    run_cli(&["agent", "paths", "remove", &label])?;
    Ok(load_paths())
}
