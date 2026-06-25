use std::path::PathBuf;
use std::process::Stdio;
use std::sync::OnceLock;

static BIN: OnceLock<PathBuf> = OnceLock::new();

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

    Err("constellation CLI not found. Download and install it from https://github.com/Mahasamuha/constellation-mcp/releases/latest".to_string())
}

// Caches only a successful resolution into `cache` — once found, the value is stable
// for the process's lifetime. A failed `resolve` is deliberately *not* cached: it's
// re-tried on every call until it succeeds once.
fn get_or_try_init<T>(cache: &OnceLock<T>, resolve: impl FnOnce() -> Result<T, String>) -> Result<&T, String> {
    if let Some(v) = cache.get() {
        return Ok(v);
    }
    let v = resolve()?;
    Ok(cache.get_or_init(|| v))
}

// Re-probing on every failed call is cheap (a couple of subprocess spawns), and means
// a GUI that autostarted before the CLI was installed/on PATH self-heals on the very
// next action — or the next 5s tray poll (see lib.rs's refresh_tray loop) — instead of
// needing a full quit-and-relaunch to pick up a since-installed CLI.
fn bin() -> Result<&'static PathBuf, String> {
    get_or_try_init(&BIN, resolve)
}

// Every node-gui-initiated CLI call is non-interactive by construction — there's
// no TTY to relay a prompt to, and a GUI button click already is the user's
// confirmation. Without this, any CLI command that grows an interactive
// confirm() (like `node rotate`/`node paths remove` did) silently no-ops here
// instead of acting, since the prompt's stdin read never gets an answer.
fn command(bin: &PathBuf, args: &[&str]) -> std::process::Command {
    let mut cmd = std::process::Command::new(bin);
    cmd.args(args)
        .env("CONSTELLATION_ASSUME_YES", "1")
        .stdin(Stdio::null());
    cmd
}

pub fn run(args: &[&str]) -> Result<(), String> {
    let bin = bin()?;
    let out = command(bin, args)
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
    let out = command(bin, args)
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn caches_success_but_retries_failure() {
        let cache: OnceLock<u32> = OnceLock::new();
        let calls = Cell::new(0);
        let try_resolve = |should_fail: bool| {
            get_or_try_init(&cache, || {
                calls.set(calls.get() + 1);
                if should_fail { Err("not found".to_string()) } else { Ok(42) }
            })
        };

        assert_eq!(try_resolve(true), Err("not found".to_string()));
        assert_eq!(try_resolve(true), Err("not found".to_string()));
        assert_eq!(calls.get(), 2, "a failed resolution must not be cached — retried every call");

        assert_eq!(try_resolve(false), Ok(&42));
        assert_eq!(calls.get(), 3);

        assert_eq!(try_resolve(true), Ok(&42), "a cached success must win even if asked to fail again");
        assert_eq!(calls.get(), 3, "a successful resolution must be cached — never retried");
    }
}
