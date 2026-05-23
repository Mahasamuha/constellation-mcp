# Constellation Agent GUI — Requirements

## Overview

A system tray application (macOS menu bar / Windows taskbar / Linux AppIndicator) that provides a graphical interface for managing the Constellation agent. Targets users who prefer not to use the CLI. The CLI remains the primary interface; the GUI is a companion.

**Technology**: Tauri v2, React + TypeScript frontend, Rust backend  
**Package**: `packages/agent-gui`  
**Platforms**: macOS, Windows, Linux

---

## Tray Icon

### Icons

Tray icons are pre-rendered PNG variants swapped at runtime via Tauri's `set_icon()`. Each variant is the full Constellation network graph SVG — the status is encoded in the center hub node's fill colors (outer ring + inner core), not a separate overlay.

**Source**: `assets/logo/hub_state_colors.html` — renders all five variants in-browser. Use this to preview colors and export PNGs at the required sizes.

- **Windows / Linux**: Full color PNGs exported directly from the SVGs in `hub_state_colors.html`
- **macOS**: Greyscale template PNGs (network graph lines/nodes in greyscale, OS tints for light/dark mode) with the center hub node rendered in color; set via `set_icon_as_template(true)`. Requires a separate macOS-specific SVG variant where only the hub node retains color.

#### Hub node colors per state

| State | Inner (`hi`) | Outer (`ho`) | Tooltip |
|-------|-------------|-------------|---------|
| Connected | `#97C459` | `#27500A` | "Constellation — Connected to \<broker\>" |
| Connecting / reconnecting | `#FAC775` | `#412402` | "Constellation — Connecting…" |
| Disconnected (clean stop) | `#B4B2A9` | `#444441` | "Constellation — Stopped" |
| Disconnected (error / timeout) | `#F09595` | `#791F1F` | "Constellation — Disconnected" |
| Not configured | `#F0997B` | `#712B13` | "Constellation — Not set up" |

#### Asset structure

```
assets/tray/
  mac/
    connected.png        # greyscale graph + green hub node
    connecting.png       # greyscale graph + yellow hub node
    disconnected.png     # greyscale graph + grey hub node
    error.png            # greyscale graph + red hub node
    unconfigured.png     # greyscale graph + orange hub node
  win-linux/
    connected.png        # full color, exported from hub_state_colors.html
    connecting.png
    disconnected.png
    error.png
    unconfigured.png
```

### Tray Menu

```
● Connected to broker.example.com          (non-clickable status line)
  agent: my-macbook · 3 paths              (non-clickable detail line)
─────────────────────────────────────────
  Status & Logs…                           → opens Status window
  Paths…                                  → opens Paths window
  Settings…                               → opens Settings window
─────────────────────────────────────────
  Start Agent                              (greyed out if running)
  Stop Agent                               (greyed out if stopped)
  Restart Agent
─────────────────────────────────────────
  Rotate Token                             → rotates agent token via broker WebSocket
  Deregister Agent…                        → confirmation dialog, clears agent.yaml
─────────────────────────────────────────
  Quit
```

When **not configured** (no `agent.yaml` or missing `agent_token`):

```
● Not set up
─────────────────────────────────────────
  Connect to Broker…                       → opens Auth window
─────────────────────────────────────────
  Quit
```

---

## Windows / Panels

All windows are small, non-resizable panels (~480px wide). They open centered on screen or near the tray icon. Only one window is open at a time.

### 1. Auth Window

Triggered by "Connect to Broker…" tray item, or from Settings when token is missing.

**Step 1 — Broker URL entry**
- Text field: "Broker URL" (e.g. `https://broker.example.com`)
- "Continue" button → initiates device code flow

**Step 2 — Device code display**
- Shows the 9-character user code in large, copyable text
- Shows the verification URL as a clickable link (opens browser)
- "Open browser" button (opens `verification_uri_complete` directly)
- QR code of the verification URL (nice-to-have)
- Spinner + "Waiting for authentication…"
- Polling in background; on success → close window, update tray to Connected
- On failure → show error with "Try again" button

### 2. Status Window

Shows live agent state and a recent log tail.

**Connection**
- Status badge (Connected / Connecting / Disconnected / Error)
- Broker URL
- Last heartbeat: "X seconds ago" (live updating)
- Disconnect reason if applicable (clean / timeout / error)

**Agent info**
- Host name
- Token created: `<date>`
- Token last used: `<date>`

**Service**
- Service state: running / stopped / unknown
- Start / Stop / Restart buttons

**Recent logs** (last 50 lines, scrollable, monospace)
- "Follow" toggle (auto-scrolls to bottom)
- "Copy all" button

### 3. Paths Window

Manages path labels (`paths.yaml`).

- Table: Label | Path | Remove button
- "Add path" form at bottom:
  - Label text field (validated: no spaces, must be unique)
  - Path text field with "Browse…" button (native folder picker)
  - "Add" button → syncs to broker immediately
- Remove button → confirms before removing
- Changes sync to broker on save (mirrors `constellation agent paths add/remove`)

### 4. Settings Window

Edits `agent.yaml` fields (except `agent_token`, which is managed via Auth).

**Fields**
- **Broker URL** — text field; change requires agent restart (warns user)
- **Agent name (host)** — text field; mirrors `constellation agent rename`
- **Max file size (KB)** — number input, range 1–100, default 100
- **Config directory** — read-only, shows resolved path (e.g. `~/.config/constellation`)

**Buttons**
- Save → writes config, syncs name change to broker if changed
- Cancel
- "Rotate token…" → confirm dialog → rotates token, saves to `agent.yaml`

**Danger zone** (collapsed by default)
- "Deregister agent" → revokes token, clears `agent.yaml`, resets to unconfigured state

---

## Behavior

### Startup
- GUI launches at OS login (configurable, default: on)
- Reads `agent.yaml` on startup; if missing or no token → unconfigured state
- Does not start/stop the agent service on launch — observes only
- Polls agent status every 5 seconds (service state + last heartbeat)

### Agent Service Control
- Start / Stop / Restart call the same underlying service manager commands as `constellation agent start/stop/restart` (systemd / launchd / Task Scheduler)
- Agent process runs independently; GUI does not host it in-process

### Config Sync
- After any path or settings change, GUI triggers a config sync to push updated labels to broker
- Shows success/error toast notification

### Notifications (v2)
- OS notification on unexpected disconnect
- OS notification when token rotation completes

---

## Out of Scope (v1)

- Broker management (agents list, filters, sessions) — CLI only
- Multi-broker / multi-account support
- Log streaming beyond last 50 lines
- MCP client session management
- Auto-update of the GUI itself

---

## Package Structure

```
packages/agent-gui/
├── src-tauri/              # Rust backend
│   ├── src/
│   │   ├── main.rs         # Tauri app entry, tray setup
│   │   ├── config.rs       # Read/write agent.yaml, paths.yaml
│   │   ├── service.rs      # Start/stop/status via OS service manager
│   │   ├── auth.rs         # Device code flow polling
│   │   └── ipc.rs          # Tauri commands exposed to frontend
│   └── tauri.conf.json
├── src/                    # React frontend
│   ├── windows/
│   │   ├── Auth.tsx
│   │   ├── Status.tsx
│   │   ├── Paths.tsx
│   │   └── Settings.tsx
│   ├── components/         # Shared UI primitives
│   └── main.tsx
├── package.json
└── index.html
```

---

## Implementation Phases

**Phase 1 — Scaffold + tray**  
Tauri app skeleton with tray icon and static menu. Read `agent.yaml` and reflect status in tray icon/tooltip.

**Phase 2 — Auth flow**  
Auth window with device code flow. Rust polls broker; updates frontend via Tauri events.

**Phase 3 — Status + service control**  
Status window with live heartbeat display. Start/Stop/Restart wired up.

**Phase 4 — Paths + Settings**  
Paths window with add/remove + broker sync. Settings window with save + rename + token rotation.

**Phase 5 — Polish**  
OS notifications on disconnect. Auto-launch on login. Packaging (DMG / NSIS / AppImage).

---

## Verification Checklist

- [ ] Tray icon reflects agent state within 5s of state change
- [ ] Auth flow completes end-to-end: broker URL → browser auth → Connected
- [ ] Paths window add/remove syncs labels to broker
- [ ] Settings save writes `agent.yaml` correctly (`constellation agent config show` to verify)
- [ ] Start/Stop/Restart correctly controls the system service on all three platforms
- [ ] Token rotation writes new token to `agent.yaml`
- [ ] Deregister clears config and returns to unconfigured state