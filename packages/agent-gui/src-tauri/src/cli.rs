use std::path::PathBuf;
use std::sync::OnceLock;

static BIN: OnceLock<Result<PathBuf, String>> = OnceLock::new();

fn resolve() -> Result<PathBuf, String> {
    // Login-shell lookup: sources ~/.profile so NVM/volta/fnm/custom npm prefixes
    // are visible even when the process was started by a desktop session manager
    // that provides only a minimal PATH.
    #[cfg(unix)]
    {
        let shell_path = std::process::Command::new("bash")
            .args(["-lc", "command -v constellation 2>/dev/null"])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| PathBuf::from(String::from_utf8_lossy(&o.stdout).trim().to_string()));

        if let Some(p) = shell_path {
            if p.exists() {
                return Ok(p);
            }
        }
    }

    // Fallback: try whatever is in the current process PATH.
    #[cfg(unix)]
    let which_cmd = "which";
    #[cfg(windows)]
    let which_cmd = "where";

    let in_path = std::process::Command::new(which_cmd)
        .arg("constellation")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| PathBuf::from(String::from_utf8_lossy(&o.stdout).lines().next().unwrap_or("").trim().to_string()));

    if let Some(p) = in_path {
        if p.exists() {
            return Ok(p);
        }
    }

    // NVM: scan every installed node version and pick the one whose
    // constellation binary was modified most recently (= active version).
    if let Some(home) = dirs::home_dir() {
        let nvm_root = home.join(".nvm/versions/node");
        if nvm_root.exists() {
            let mut candidates: Vec<PathBuf> = std::fs::read_dir(&nvm_root)
                .into_iter()
                .flatten()
                .flatten()
                .map(|e| e.path().join("bin/constellation"))
                .filter(|p| p.exists())
                .collect();

            candidates.sort_by_key(|p| {
                std::cmp::Reverse(p.metadata().and_then(|m| m.modified()).ok())
            });

            if let Some(p) = candidates.into_iter().next() {
                return Ok(p);
            }
        }

        // Other common global install locations.
        for suffix in [
            ".npm-global/bin/constellation",
            ".local/bin/constellation",
            ".npm/bin/constellation",
        ] {
            let p = home.join(suffix);
            if p.exists() {
                return Ok(p);
            }
        }
    }

    // macOS Homebrew and system-wide fallbacks.
    for p in [
        "/opt/homebrew/bin/constellation",
        "/usr/local/bin/constellation",
        "/usr/bin/constellation",
    ] {
        if std::path::Path::new(p).exists() {
            return Ok(PathBuf::from(p));
        }
    }

    Err("constellation CLI not found. Make sure @mahasamuha/constellation-agent is installed globally.".to_string())
}

fn bin() -> Result<&'static PathBuf, String> {
    BIN.get_or_init(resolve).as_ref().map_err(|e| e.clone())
}

pub fn run(args: &[&str]) -> Result<(), String> {
    let bin = bin()?;
    let out = std::process::Command::new(bin)
        .args(args)
        .output()
        .map_err(|e| format!("Could not run constellation: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            format!("constellation {} failed (exit {})", args.join(" "), out.status)
        } else {
            stderr
        })
    }
}

pub fn output(args: &[&str]) -> Result<String, String> {
    let bin = bin()?;
    let out = std::process::Command::new(bin)
        .args(args)
        .output()
        .map_err(|e| format!("Could not run constellation: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            format!("constellation {} failed (exit {})", args.join(" "), out.status)
        } else {
            stderr
        })
    }
}
