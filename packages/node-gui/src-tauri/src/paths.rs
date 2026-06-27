use serde::{Deserialize, Serialize};

use crate::config;

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct PathEntry {
    pub share: String,
    pub path: String,
    #[serde(default)]
    pub instructions: Option<String>,
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

#[tauri::command]
pub fn get_paths() -> Vec<PathEntry> {
    load_paths()
}

#[tauri::command]
pub async fn add_path(share: String, path: String, instructions: Option<String>) -> Result<Vec<PathEntry>, String> {
    let meta = std::fs::metadata(&path)
        .map_err(|_| format!("Path '{}' does not exist", path))?;
    if !meta.is_dir() {
        return Err(format!("'{}' is not a directory", path));
    }
    let mut args = vec!["node", "paths", "add"];
    if let Some(ref text) = instructions {
        if !text.trim().is_empty() {
            args.push("--instructions");
            args.push(text);
        }
    }
    args.push("--");
    args.push(&share);
    args.push(&path);
    crate::cli::run(&args)?;
    Ok(load_paths())
}

#[tauri::command]
pub async fn remove_path(share: String) -> Result<Vec<PathEntry>, String> {
    crate::cli::run(&["node", "paths", "remove", "--", &share])?;
    Ok(load_paths())
}
