use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Deserialize, Serialize, Default, Clone)]
pub struct NodeConfig {
    pub relay_url: Option<String>,
    pub node_token: Option<String>,
    pub host: Option<String>,
    pub max_file_size_kb: Option<u32>,
}

/// What `get_config` exposes to the webview. The renderer is the least-trusted part
/// of this app (XSS, a compromised npm dependency, or local devtools access can all
/// read whatever crosses into it) and never reads `node_token` — so the long-lived
/// node credential stays Rust-side only, never serialized across the IPC boundary.
#[derive(Debug, Serialize, Default, Clone)]
pub struct RendererNodeConfig {
    pub relay_url: Option<String>,
    pub host: Option<String>,
    pub max_file_size_kb: Option<u32>,
}

impl From<&NodeConfig> for RendererNodeConfig {
    fn from(cfg: &NodeConfig) -> Self {
        Self {
            relay_url: cfg.relay_url.clone(),
            host: cfg.host.clone(),
            max_file_size_kb: cfg.max_file_size_kb,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum NodeState {
    Unconfigured,
    Disconnected,
    Connecting,
    Connected,
    Error,
}

pub fn config_dir() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("constellation")
}

pub fn load_node_config() -> NodeConfig {
    let path = config_dir().join("node.yaml");
    match std::fs::read_to_string(&path) {
        Ok(content) => serde_yaml::from_str(&content).unwrap_or_default(),
        Err(_) => NodeConfig::default(),
    }
}

pub fn detect_state(config: &NodeConfig, service: &str) -> NodeState {
    if config.relay_url.is_none() || config.node_token.is_none() {
        return NodeState::Unconfigured;
    }
    match service {
        "active" => NodeState::Connected,
        "inactive" => NodeState::Disconnected,
        _ => NodeState::Error,
    }
}
