# MCP Client Setup

How to connect Claude, ChatGPT, and Cursor to a running Constellation broker.

## Prerequisites

- A Constellation broker running at a publicly accessible HTTPS URL
- At least one agent registered and online (`constellation broker agents list`)

---

## Claude (claude.ai)

### 1. Add the integration

1. Open [claude.ai](https://claude.ai) and go to **Settings → Integrations**
2. Click **Add integration**
3. Enter your broker's MCP endpoint URL: `https://<your-broker>/mcp`
4. Claude redirects you to the broker's login page — sign in with your Constellation account
5. After authorizing, Claude returns to the integration page and the connection is active

### 3. Verify

Start a new conversation and ask Claude to list your available paths or read a file. The `list_labels` tool returns all registered path labels across your online agents.

---

## ChatGPT

Available on Pro, Team, Enterprise, and Edu plans.

> **Note:** MCP connectors in ChatGPT require Developer Mode to be enabled. This is a per-conversation toggle, not a global setting.

### 1. Add the connector

1. Open [chatgpt.com](https://chatgpt.com) and go to **Settings → Apps & Connectors**
2. Click **Add new connector**
3. Enter a name (e.g. `Constellation`) and your broker's MCP endpoint URL: `https://<your-broker>/mcp`
4. Set authentication to **OAuth**
5. Click **Create** — ChatGPT redirects you to the broker's login page
6. Sign in with your Constellation account and authorize the connection

### 3. Use the connector in a conversation

MCP connectors must be activated per conversation:

1. Start a new chat
2. Click the **+** icon in the message composer → **More**
3. Enable **Developer Mode**
4. Select your Constellation connector from the list

### 4. Verify

Ask ChatGPT to list your available paths or read a file. The `list_labels` tool returns all registered path labels across your online agents.

---

## Cursor

### 1. Add the server config

Create or edit `.cursor/mcp.json` in your project root for a project-scoped connection, or `~/.cursor/mcp.json` for a global connection available in all projects:

```json
{
  "mcpServers": {
    "constellation": {
      "url": "https://<your-broker>/mcp"
    }
  }
}
```

### 2. Authorize

On first use, Cursor opens a browser window to complete the OAuth flow. Sign in with your Constellation account and authorize the connection. Cursor stores the resulting session and reuses it automatically.

### 3. Verify

Open the Cursor MCP panel (or invoke a tool call in the agent) — Constellation's tools should appear. Use `list_labels` to confirm your agents' registered paths are visible.

---

## Revoking a session

To disconnect a client, revoke its OAuth session:

```bash
constellation broker sessions list
constellation broker sessions revoke <session-id>
```

Both the access token and refresh token are invalidated immediately.
