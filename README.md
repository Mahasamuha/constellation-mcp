# Constellation

A network-accessible MCP file server. Run a local agent on any machine and access its filesystem from any MCP client (Claude, Cursor, GitHub Copilot) through a central broker.

```
MCP client → broker (VPS) → agent (your machine)
```

The agent never opens inbound ports. All traffic flows outbound from the agent to the broker over WebSocket. The broker authenticates MCP clients via OAuth 2.0. The agent is the security boundary — it enforces path restrictions locally regardless of what the broker forwards.

---

## Requirements

- Docker and Docker Compose (broker)
- Node.js 20+ or a standalone `constellation` binary (agent)
- An OIDC provider (Google, Azure AD, or self-hosted Authentik)

---

## 1. Deploy the broker

### Configure environment

Copy the example and fill in the required values:

```sh
cp packages/broker/.env.example packages/broker/.env
```

`packages/broker/.env` is shared by both the broker and the Postgres container. Set `POSTGRES_USER`, `POSTGRES_PASSWORD`, and `POSTGRES_DB` there, and make sure `DATABASE_URL` uses the same credentials.

Required variables:

| Variable | Description |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `OIDC_ISSUER` | OIDC provider issuer URL |
| `OIDC_CLIENT_ID` | Client ID from your OIDC provider |
| `OIDC_CLIENT_SECRET` | Client secret from your OIDC provider |
| `OIDC_CALLBACK_URL` | `https://your-broker.example.com/oauth/callback` |
| `BROKER_URL` | Public URL of the broker, e.g. `https://your-broker.example.com` |

### OIDC provider setup

The broker works with any OIDC-compliant provider. Register an OAuth application and add both redirect/callback URLs:
- `https://your-broker.example.com/oauth/callback` — used by MCP clients (Claude, Cursor)
- `https://your-broker.example.com/activate/callback` — used by the agent and broker CLI device flows

**Google (simplest for personal use)**

1. Go to [Google Cloud Console → APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials)
2. Create an OAuth 2.0 Client ID (Web application)
3. Add both redirect URIs as authorized redirect URIs
4. Set `OIDC_ISSUER=https://accounts.google.com`

**Azure Active Directory**

1. Register an app in [Azure Portal → App registrations](https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps)
2. Add both redirect URIs
3. Set `OIDC_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0`

**Authentik (self-hosted)**

1. Create an OAuth2/OpenID Provider in Authentik
2. Add both redirect URIs to the provider
3. Set `OIDC_ISSUER=https://your-authentik.example.com/application/o/<slug>/`

### Start with Docker Compose

```sh
docker compose up -d
```

On first start the broker automatically applies any pending database migrations before accepting connections. Subsequent deploys do the same — no manual migration step required.

Add a reverse proxy (Caddy or nginx) in front for TLS. Example Caddyfile:

```
your-broker.example.com {
    reverse_proxy localhost:3000
}
```

---

## 2. Install the agent

### Via npm

```sh
npm install -g @mahasamuha/constellation-agent
```

### Initialize

Run this on the machine whose filesystem you want to expose:

```sh
constellation agent init --broker https://your-broker.example.com
```

This opens a browser, authenticates you via your OIDC provider, and writes credentials to `~/.config/constellation/agent.yaml` (Linux/macOS) or `%APPDATA%\constellation\agent.yaml` (Windows).

**Set config file permissions** (Linux/macOS):

```sh
chmod 600 ~/.config/constellation/agent.yaml
chmod 600 ~/.config/constellation/paths.yaml
```

### Configure paths

Add paths with the CLI (syncs to the broker automatically):

```sh
constellation agent paths add projects /home/user/projects
constellation agent paths add dotfiles /home/user/.config
```

Or edit `~/.config/constellation/paths.yaml` directly and push manually:

```sh
constellation agent sync
```

Labels must be unique across all your agents.

### Install as a system service

```sh
constellation agent install
constellation agent start
```

This registers the agent with your OS service manager (systemd on Linux, launchd on macOS, Task Scheduler on Windows) and starts it. The agent connects to the broker and reconnects automatically on restart.

---

## 3. Connect an MCP client

Add the broker as an MCP server in your client. The broker handles OAuth automatically — most clients (Claude, Cursor, Copilot) will open a browser on first connection.

**Claude (claude.ai)**

In Claude settings → Integrations, add:
```
https://your-broker.example.com/mcp
```

**Cursor**

In `.cursor/mcp.json`:
```json
{
  "mcpServers": {
    "constellation": {
      "url": "https://your-broker.example.com/mcp"
    }
  }
}
```

**GitHub Copilot**

Add the server URL in your IDE's Copilot MCP settings. Copilot will attempt Dynamic Client Registration automatically.

---

## 4. Using the tools

Once connected, the model can use these tools:

| Tool | What it does |
|---|---|
| `list_hosts` | Show all your registered machines with online status |
| `list_labels` | Show path labels, optionally filtered by host |
| `list_directory` | Browse a directory tree |
| `file_info` | Check file size and type before reading |
| `read_file` | Read a file, with optional line range |
| `grep_files` | Search file contents by literal string or regex |
| `search_files` | Find files by name pattern |
| `write_file` | Write or append to a file |
| `edit_file` | Apply exact-match text substitutions |
| `copy` | Copy a file or directory |
| `move` | Move a file or directory |
| `create_directory` | Create a directory |
| `delete` | Delete a file or directory (prompts for confirmation on directories) |

Example prompts:
- *"What machines do I have connected?"* → `list_hosts`
- *"Show me the structure of my projects directory"* → `list_directory` with `recursive: true`
- *"Find all .env files in projects"* → `search_files`
- *"Fix the bug in src/auth.ts"* → `read_file`, then `edit_file`

---

## 5. Agent CLI reference

```sh
constellation agent init        # First-time setup
constellation agent install     # Register with OS service manager
constellation agent start       # Start the service
constellation agent stop        # Stop the service
constellation agent restart     # Restart the service
constellation agent status      # Show connection state and labels
constellation agent sync        # Push paths.yaml changes to broker (after manual edits)
constellation agent rotate      # Rotate agent token
constellation agent rename <h>  # Update host name
constellation agent logs [-f]   # Show service logs
constellation agent paths list  # List configured labels
constellation agent paths add <label> <path>   # Add label and sync
constellation agent paths remove <label>       # Remove label and sync
```

## 6. Broker CLI reference

```sh
constellation broker login              # Authenticate with broker management API
constellation broker status             # Broker health and version
constellation broker agents list        # All agents with liveness status
constellation broker agents revoke <id> # Revoke an agent token
constellation broker labels list        # All path labels
constellation broker filters list       # Active deny filters
constellation broker filters add <pattern> [--type glob|regex]
constellation broker filters remove <id>
constellation broker sessions list      # Active MCP client sessions
constellation broker sessions revoke <id>
constellation broker account deactivate
```
