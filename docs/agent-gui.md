# Agent GUI Reference

The agent GUI is a system tray application that provides a graphical interface for managing the Constellation agent. It observes the agent service and configuration, exposes the device-code auth flow, and lets you manage paths and settings without using the CLI.

**Technology**: Tauri v2, React + TypeScript frontend, Rust backend  
**Package**: `packages/agent-gui`  
**Platforms**: macOS, Windows, Linux

The CLI remains the primary interface; the GUI is a companion. It does not host the agent process — it only observes and controls it.

---

## Tray Icon

The tray icon is the full Constellation network graph SVG. State is encoded in the hub node's fill colors — no separate overlay.

Icon PNGs are pre-rendered at `src-tauri/icons/tray/` and swapped at runtime via `set_icon()`. To regenerate them after editing the color spec, run:

```sh
python3 assets/logo/generate_tray_icons.py
```

The color spec lives in `assets/logo/hub_state_colors.html`. Edit the `STATES` array there and re-run the script to update all icons.

### States

| State | Tray icon | Tooltip |
|---|---|---|
| Connected | Blue hub | `Constellation — Connected to <broker-url>` |
| Connecting | Yellow hub | `Constellation — Connecting…` |
| Disconnected (stopped) | Grey hub | `Constellation — Stopped` |
| Error (unexpected disconnect) | Red hub | `Constellation — Disconnected` |
| Unconfigured (no `agent.yaml`) | Grey hub | `Constellation — Not set up` |

State is derived from `agent.yaml` and the OS service status:

- No `broker_url` or `agent_token` in config → **Unconfigured**
- Service state `active` → **Connected**
- Service state `inactive` → **Disconnected**
- Any other service state → **Error**

The tray polls every 5 seconds and after every menu action (Start / Stop / Restart).

---

## Tray Menu

### Configured state

```
● Connected to broker.example.com      (non-clickable)
  agent: my-machine · 3 paths          (non-clickable)
──────────────────────────────────────
  Status & Logs…                       → Status window
  Paths…                               → Paths window
  Settings…                            → Settings window
──────────────────────────────────────
  Start Agent                          (disabled if running)
  Stop Agent                           (disabled if stopped)
  Restart Agent
──────────────────────────────────────
  Quit
```

The status line reflects the current state:

| State | Status line text |
|---|---|
| Connected | `● Connected to <broker-url>` |
| Connecting | `● Connecting…` |
| Disconnected | `● Stopped` |
| Error | `● Disconnected` |

Start / Stop / Restart run the corresponding `constellation agent <cmd>` CLI command in a background thread and refresh the tray on completion.

### Unconfigured state

```
● Not set up                           (non-clickable)
──────────────────────────────────────
  Connect to Broker…                   → Auth window
──────────────────────────────────────
  Quit
```

---

## Windows

All windows are non-resizable panels (~480 px wide) that open centered on screen. A window that is already open is focused rather than reopened.

### Auth Window (`480 × 280`)

Triggered by **Connect to Broker…** in the tray menu, or from Settings when the token is missing.

**Step 1 — Broker URL**  
Enter the broker base URL (e.g. `https://broker.example.com`) and click Continue. The GUI calls `start_device_flow`, which POSTs to `/oauth/device/code` with scope `agent:register`.

**Step 2 — Device code**  
The broker returns a 9-character user code and a verification URL. The GUI displays the code and a button to open the verification URL in the browser. It then calls `poll_device_flow`, which polls `/oauth/token` every `interval` seconds (as specified in the broker response).

Poll outcomes:
- `authorization_pending` — continue polling, emit `Pending` event to frontend
- `slow_down` / `rate_limit_exceeded` — continue polling at the same interval
- Any other error — emit `Error` event with the error string
- Timeout (device code `expires_in` elapsed) — emit `Timeout` event
- Success — write `agent.yaml` with `broker_url`, `agent_token`, and `host`; create `paths.yaml` if absent; emit `Success { host }` event; tray refreshes to Connected

Auth results are delivered to the frontend via Tauri events on the `auth-result` channel.

### Status Window (`480 × 560`)

Shows live agent state. Polls the same data sources as the tray.

**Connection section**
- Status badge (Connected / Connecting / Stopped / Disconnected / Not set up)
- Broker URL
- Last heartbeat timestamp
- Disconnect reason (if applicable)

**Agent info section**
- Host name
- Token created date
- Token last used date

**Service section**
- Service state: running / stopped / unknown
- Start / Stop / Restart buttons (call the same commands as the tray menu)

**Logs section**
- Last 50 lines of agent service logs (monospace)
- Follow toggle (auto-scrolls to bottom)
- Copy all button

### Paths Window (`720 × 420`)

Manages path labels from `paths.yaml`. Changes sync to the broker immediately via `constellation agent paths add/remove`.

- Table: Label | Path | Remove button
- **Add path** form: label text field, path text field with Browse… button (native folder picker), Add button
- Remove prompts for confirmation before calling `remove_path`
- Path must be an existing directory; labels must be unique

### Settings Window (`480 × 380`)

Edits `agent.yaml` fields. `agent_token` is managed via the Auth window only.

| Field | Notes |
|---|---|
| Broker URL | Changing this requires an agent restart |
| Agent name (host) | Calls `constellation agent rename` if changed |
| Max file size (KB) | Range 1–100; written directly to `agent.yaml` |
| Config directory | Read-only; shows the resolved path |

**Buttons**: Save (writes config, renames if host changed), Cancel

**Danger zone** (collapsed by default):
- Rotate token — calls `constellation agent rotate`, fires an OS notification on success
- Deregister agent — confirmation dialog, calls `constellation agent deregister`, clears `agent.yaml`, resets to Unconfigured

---

## Notifications

OS notifications are sent in two situations:

| Event | Title | Body |
|---|---|---|
| Transition into Error state | `Constellation` | `Disconnected from broker unexpectedly.` |
| Token rotation success | `Constellation` | `Agent token rotated successfully.` |

The disconnect notification is only fired on state *transitions* into Error — not on the initial poll at startup. If the app is already in Error state when it launches, no notification is sent.

---

## Auto-launch

The GUI registers itself for auto-launch on login via `tauri-plugin-autostart`. On first run, auto-launch is enabled automatically if it is not already configured. The current state and a toggle are exposed via the `get_autostart` / `set_autostart` IPC commands for wiring into Settings.

| Platform | Mechanism |
|---|---|
| Linux | XDG autostart (`~/.config/autostart/`) |
| macOS | LaunchAgent (`~/Library/LaunchAgents/`) |
| Windows | Registry (`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`) |

---

## IPC Commands

All commands are invoked from the frontend via `invoke('<name>', args)`.

### Config

| Command | Args | Returns | Notes |
|---|---|---|---|
| `get_config` | — | `AgentConfig` | Reads `agent.yaml` |
| `get_config_dir` | — | `string` | Resolved config directory path |
| `save_settings` | `broker_url`, `host`, `max_file_size_kb` | `void` | Writes `agent.yaml`; calls `agent rename` if host changed |
| `update_tray` | — | `void` | Force-refreshes tray state |

### Auth

| Command | Args | Returns | Notes |
|---|---|---|---|
| `start_device_flow` | `broker_url` | `DeviceCodeInfo` | POSTs to `/oauth/device/code` |
| `poll_device_flow` | `broker_url`, `device_code`, `interval`, `expires_in` | `void` | Emits `auth-result` events until resolved |

`DeviceCodeInfo`: `{ device_code, user_code, verification_uri, verification_uri_complete, expires_in, interval }`

`auth-result` event payload (`AuthResult`):

```ts
| { status: "pending" }
| { status: "success", host: string }
| { status: "error", message: string }
| { status: "timeout" }
```

### Service

| Command | Args | Returns | Notes |
|---|---|---|---|
| `get_service_status` | — | `string` | `"active"` \| `"inactive"` \| `"unknown"` |
| `get_agent_broker_info` | — | `AgentBrokerInfo \| null` | Fetches from broker management API |
| `start_agent` | — | `void` | `constellation agent start` |
| `stop_agent` | — | `void` | `constellation agent stop` |
| `restart_agent` | — | `void` | `constellation agent restart` |
| `rotate_token` | — | `void` | `constellation agent rotate`; fires OS notification |
| `deregister_agent` | — | `void` | Deletes `agent.yaml`; resets to Unconfigured |
| `get_logs` | `lines: number` | `string` | `constellation agent logs --lines <n>` |

`AgentBrokerInfo`: `{ connected, last_heartbeat_at, last_disconnect_reason, registered_at, token_last_used_at }`

### Paths

| Command | Args | Returns | Notes |
|---|---|---|---|
| `get_paths` | — | `PathEntry[]` | Reads `paths.yaml` |
| `add_path` | `label`, `path` | `PathEntry[]` | Validates directory exists; calls `agent paths add` |
| `remove_path` | `label` | `PathEntry[]` | Calls `agent paths remove` |

`PathEntry`: `{ label: string, path: string }`

### Auto-launch

| Command | Args | Returns | Notes |
|---|---|---|---|
| `get_autostart` | — | `boolean` | Whether auto-launch is currently enabled |
| `set_autostart` | `enabled: boolean` | `void` | Enable or disable auto-launch |

---

## Packaging

Build artifacts are produced by `npm run tauri build` (or `cargo tauri build`). The bundle targets `all`, which produces:

| Platform | Formats |
|---|---|
| macOS | `.app`, `.dmg` |
| Windows | `.exe` (NSIS installer, per-user) |
| Linux | `.AppImage`, `.deb` |

Bundle metadata in `src-tauri/tauri.conf.json`:

| Field | Value |
|---|---|
| `identifier` | `app.joerybka.constellation` |
| `category` | `Utility` |
| `macOS.minimumSystemVersion` | `10.15` |
| `windows.nsis.installMode` | `currentUser` |
