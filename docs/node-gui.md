# Node GUI Reference

The node GUI is a system tray application that provides a graphical interface for managing the Constellation node. It observes the node service and configuration, exposes the device-code auth flow, and lets you manage paths and settings without using the CLI.

**Technology**: Tauri v2, React + TypeScript frontend, Rust backend  
**Package**: `packages/node-gui`  
**Platforms**: macOS, Windows, Linux

The CLI remains the primary interface; the GUI is a companion. It does not host the node process — it only observes and controls it.

---

## Tray Icon

The tray icon is the full Constellation network graph SVG. State is encoded in the fill color of the graph's center vertex — referred to below as the "hub node" in the graph-theory sense (the center of the icon's network graph), not the Constellation Hub component — no separate overlay.

Icon PNGs are pre-rendered at `src-tauri/icons/tray/` (within `packages/node-gui`) and swapped at runtime via `set_icon()`. To regenerate them after editing the color spec, run from the repo root (the script and color spec below live at the repo root, not under `packages/node-gui`):

```sh
python3 assets/logo/generate_tray_icons.py
```

The color spec lives in `assets/logo/hub_state_colors.html` (also relative to the repo root). Edit the `STATES` array there and re-run the script to update all icons.

### States

| State | Tray icon | Tooltip |
|---|---|---|
| Connected | Blue hub | `Constellation — Connected to <relay-url>` |
| Connecting | Yellow hub | `Constellation — Connecting…` |
| Disconnected (stopped) | Grey hub | `Constellation — Stopped` |
| Error (unexpected disconnect) | Red hub | `Constellation — Disconnected` |
| Unconfigured (no `node.yaml`) | Grey hub | `Constellation — Not set up` |

State is derived from `node.yaml` and the OS service status:

- No `relay_url` or `node_token` in config → **Unconfigured**
- Service state `active` → **Connected**
- Service state `inactive` → **Disconnected**
- Any other service state → **Error**

The tray polls every 5 seconds and after every menu action (Start / Stop / Restart).

---

## Tray Menu

### Configured state

```
● Connected to relay.example.com       (non-clickable)
  node: my-machine · 3 paths           (non-clickable)
──────────────────────────────────────
  Status & Logs…                       → Status window
  Paths…                               → Paths window
  Settings…                            → Settings window
──────────────────────────────────────
  Start Node                           (disabled if running)
  Stop Node                            (disabled if stopped)
  Restart Node
──────────────────────────────────────
  Quit
```

The status line reflects the current state:

| State | Status line text |
|---|---|
| Connected | `● Connected to <relay-url>` |
| Connecting | `● Connecting…` |
| Disconnected | `● Stopped` |
| Error | `● Disconnected` |

Start / Stop / Restart run the corresponding `constellation node <cmd>` CLI command in a background thread and refresh the tray on completion.

### Unconfigured state

```
● Not set up                           (non-clickable)
──────────────────────────────────────
  Connect to Relay…                    → Auth window
──────────────────────────────────────
  Quit
```

---

## Windows

All windows are non-resizable panels that open centered on screen. A window that is already open is focused rather than reopened. Most are ~480 px wide; see each window's heading below for its exact dimensions.

### Auth Window (`480 × 280`)

Triggered by **Connect to Relay…** in the tray menu, or from Settings when the token is missing.

**Step 1 — Relay URL**  
Enter the relay base URL (e.g. `https://relay.example.com`) and click Continue. The GUI calls `start_device_flow`, which POSTs to `/oauth/device/code` with scope `agent:register`.

**Step 2 — Device code**  
The relay returns a 9-character user code and a verification URL. The GUI displays the code and a button to open the verification URL in the browser. It then calls `poll_device_flow`, which polls `/oauth/token` every `interval` seconds (as specified in the relay response).

Poll outcomes:
- `authorization_pending` — continue polling, emit `Pending` event to frontend
- `slow_down` — continue polling, increase interval by 5 seconds
- `rate_limit_exceeded` — continue polling at the same interval
- Any other error — emit `Error` event with the error string
- Timeout (device code `expires_in` elapsed) — emit `Timeout` event
- Success — write `node.yaml` with `relay_url`, `node_token`, and `host`; create `paths.yaml` if absent; emit `Success { host }` event; tray refreshes to Connected

Auth results are delivered to the frontend via Tauri events on the `auth-result` channel.

### Status Window (`480 × 560`)

Shows live node state. Polls the same data sources as the tray.

**Connection section**
- Status badge (Connected / Connecting / Stopped / Disconnected / Not set up)
- Relay URL
- Last heartbeat timestamp
- Disconnect reason (if applicable)

**Node info section**
- Host name
- Token created date
- Token last used date

**Service section**
- Service state: running / stopped / unknown
- Start / Stop / Restart buttons (call the same commands as the tray menu)

**Logs section**
- Last 50 lines of node service logs (monospace)
- Follow toggle (auto-scrolls to bottom)
- Copy all button

### Paths Window (`720 × 420`)

Manages path shares from `paths.yaml`. Changes sync to the relay immediately via `constellation node paths add/remove`.

- Table: Share | Path | Instructions (truncated, full text on hover) | Remove button
- **Add path** form: share text field, path text field with Browse… button (native folder picker), instructions textarea with a live character counter (500 max), Add button
- Remove prompts for confirmation before calling `remove_path`
- Path must be an existing directory; shares must be unique; instructions over 500 characters disable the Add button

### Settings Window (`480 × 380`)

Edits `node.yaml` fields. `node_token` is managed via the Auth window only.

| Field | Notes |
|---|---|
| Relay URL | Changing this requires a node restart |
| Node name (host) | Calls `constellation node rename` if changed |
| Max file size (KB) | Range 1–100; written directly to `node.yaml` |
| Config directory | Read-only; shows the resolved path |

**Buttons**: Save (writes config, renames if host changed), Cancel

**Danger zone** (collapsed by default):
- Rotate token — calls `constellation node rotate`, fires an OS notification on success
- Deregister node — confirmation dialog, deletes `node.yaml` directly, resets to Unconfigured

---

## Notifications

OS notifications are sent in two situations:

| Event | Title | Body |
|---|---|---|
| Transition into Error state | `Constellation` | `Disconnected from relay unexpectedly.` |
| Token rotation success | `Constellation` | `Node token rotated successfully.` |

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
| `get_config` | — | `NodeConfig` | Reads `node.yaml` |
| `get_config_dir` | — | `string` | Resolved config directory path |
| `save_settings` | `relay_url`, `host`, `max_file_size_kb` | `void` | Writes `node.yaml`; calls `node rename` if host changed |
| `update_tray` | — | `void` | Force-refreshes tray state |

### Auth

| Command | Args | Returns | Notes |
|---|---|---|---|
| `start_device_flow` | `relay_url` | `DeviceCodeInfo` | POSTs to `/oauth/device/code` |
| `poll_device_flow` | `relay_url`, `device_code`, `interval`, `expires_in` | `void` | Emits `auth-result` events until resolved |

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
| `get_node_relay_info` | — | `NodeRelayInfo \| null` | Fetches from relay management API |
| `start_node` | — | `void` | `constellation node start` |
| `stop_node` | — | `void` | `constellation node stop` |
| `restart_node` | — | `void` | `constellation node restart` |
| `rotate_token` | — | `void` | `constellation node rotate`; fires OS notification |
| `deregister_node` | — | `void` | Deletes `node.yaml`; resets to Unconfigured |
| `get_logs` | `lines: number` | `string` | `constellation node logs --lines <n>` |

`NodeRelayInfo`: `{ connected, last_heartbeat_at, last_disconnect_reason, registered_at, token_last_used_at }`

### Paths

| Command | Args | Returns | Notes |
|---|---|---|---|
| `get_paths` | — | `PathEntry[]` | Reads `paths.yaml` |
| `add_path` | `share`, `path`, `instructions?` | `PathEntry[]` | Validates directory exists; calls `node paths add [--instructions <text>]` |
| `remove_path` | `share` | `PathEntry[]` | Calls `node paths remove` |

`PathEntry`: `{ share: string, path: string }`

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
