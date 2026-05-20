import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Router, Request, Response, IRouter } from "express";
import { z } from "zod/v4";
import { prisma } from "./db.js";
import { routeToolCall, RouterError } from "./router.js";
import { hashToken, createLogger } from "@constellation/shared";

const log = createLogger("mcp");

export const mcpRouter: IRouter = Router();

// ---------------------------------------------------------------------------
// Auth middleware — sets req.auth for the SDK transport
// ---------------------------------------------------------------------------

async function resolveBearerToken(token: string): Promise<{
  userId: string;
  clientId: string;
  expiresAt: Date;
} | null> {
  const tokenHash = hashToken(token);
  const session = await prisma.oauthSession.findUnique({
    where: { accessTokenHash: tokenHash },
    include: { user: { select: { id: true, deactivatedAt: true } } },
  });

  if (!session) return null;
  if (session.expiresAt < new Date()) return null;
  if (session.user.deactivatedAt !== null) return null;

  return { userId: session.user.id, clientId: session.mcpClientId, expiresAt: session.expiresAt };
}

// ---------------------------------------------------------------------------
// Route: POST /mcp  (and GET for SSE)
// ---------------------------------------------------------------------------

mcpRouter.all("/mcp", async (req: Request, res: Response) => {
  // Validate bearer token and attach auth info for the SDK.
  const authHeader = req.headers["authorization"];
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const session = await resolveBearerToken(token);
  if (!session) {
    res.status(401).json({ error: "invalid_token" });
    return;
  }

  // Attach auth to the request so the transport passes it to tool callbacks.
  (req as Request & { auth: object }).auth = {
    token,
    clientId: session.clientId,
    scopes: [],
    expiresAt: Math.floor(session.expiresAt.getTime() / 1000),
    extra: { userId: session.userId },
  };

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = buildMcpServer();

  await server.connect(transport);

  try {
    await transport.handleRequest(req as Parameters<typeof transport.handleRequest>[0], res, req.body);
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// MCP server factory
// ---------------------------------------------------------------------------

function buildMcpServer(): McpServer {
  const server = new McpServer({
    name: "constellation",
    version: "0.1.0",
  });

  registerListHosts(server);
  registerListLabels(server);
  registerListDirectory(server);
  registerFileInfo(server);
  registerSearchFiles(server);
  registerReadFile(server);
  registerGrepFiles(server);
  registerWriteFile(server);
  registerEditFile(server);
  registerCopy(server);
  registerCreateDirectory(server);
  registerDelete(server);
  registerMove(server);

  return server;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function userId(extra: { authInfo?: { extra?: Record<string, unknown> } }): string {
  const id = extra.authInfo?.extra?.["userId"];
  if (typeof id !== "string") throw new Error("Missing userId in auth context");
  return id;
}

/** Converts a RouterError to a thrown MCP tool error string. */
function routerErrorMessage(err: RouterError): string {
  return err.message;
}

function isRouterError(v: unknown): v is RouterError {
  return typeof v === "object" && v !== null && "code" in v;
}

type ToolResult = { content: Array<{ type: "text"; text: string }> };

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function toolError(message: string): never {
  throw new Error(message);
}

async function dispatch(
  uid: string,
  tool: string,
  label: string,
  params: Record<string, unknown>,
  host?: string
): Promise<ToolResult> {
  const result = await routeToolCall(uid, tool, label, params, host);
  if (isRouterError(result)) toolError(routerErrorMessage(result));
  if (result.error) toolError(typeof result.error === "string" ? result.error : JSON.stringify(result.error));
  return ok(result.result);
}

// ---------------------------------------------------------------------------
// list_hosts
// ---------------------------------------------------------------------------

function registerListHosts(server: McpServer): void {
  server.tool(
    "list_hosts",
    "List all registered hosts with liveness status and their labels",
    {},
    { readOnlyHint: true },
    async (_args, extra) => {
      const uid = userId(extra);
      const heartbeatThresholdMs =
        parseInt(process.env["HEARTBEAT_INTERVAL_SECONDS"] ?? "60", 10) *
        parseInt(process.env["HEARTBEAT_MAX_MISSED"] ?? "3", 10) *
        1000;

      const agents = await prisma.agent.findMany({
        where: { userId: uid },
        include: { pathLabels: { select: { label: true } } },
      });

      const hosts = agents.map((a) => ({
        host: a.host,
        online:
          a.lastHeartbeatAt !== null &&
          Date.now() - a.lastHeartbeatAt.getTime() < heartbeatThresholdMs,
        last_seen: a.lastHeartbeatAt?.toISOString() ?? null,
        labels: a.pathLabels.map((pl) => pl.label),
      }));

      return ok(hosts);
    }
  );
}

// ---------------------------------------------------------------------------
// list_labels
// ---------------------------------------------------------------------------

function registerListLabels(server: McpServer): void {
  server.tool(
    "list_labels",
    "List path labels, optionally filtered by host",
    { host: z.string().optional() },
    { readOnlyHint: true },
    async ({ host }, extra) => {
      const uid = userId(extra);

      const labels = await prisma.pathLabel.findMany({
        where: {
          userId: uid,
          ...(host ? { agent: { host } } : {}),
        },
        include: { agent: { select: { host: true } } },
      });

      return ok(labels.map((l) => ({
        label: l.label,
        host: l.agent.host,
        reported_path: l.reportedPath,
      })));
    }
  );
}

// ---------------------------------------------------------------------------
// list_directory
// ---------------------------------------------------------------------------

function registerListDirectory(server: McpServer): void {
  server.tool(
    "list_directory",
    "List the contents of a label root or subdirectory. Use recursive:true with exclude:[\"node_modules\",\".git\"] for repo trees. Returns truncated:true and truncated_by when a limit or max_depth is hit.",
    {
      label: z.string(),
      relative_path: z.string().optional(),
      recursive: z.boolean().optional(),
      max_depth: z.number().int().optional(),
      limit: z.number().int().optional(),
      exclude: z.array(z.string()).optional(),
      host: z.string().optional(),
    },
    { readOnlyHint: true },
    async ({ label, host, ...params }, extra) => dispatch(userId(extra), "list_directory", label, params, host)
  );
}

// ---------------------------------------------------------------------------
// file_info
// ---------------------------------------------------------------------------

function registerFileInfo(server: McpServer): void {
  server.tool(
    "file_info",
    "Returns size, mtime, and type (file/directory/symlink) for a path. Use before read_file to check size.",
    {
      label: z.string(),
      relative_path: z.string(),
      host: z.string().optional(),
    },
    { readOnlyHint: true },
    async ({ label, host, ...params }, extra) => dispatch(userId(extra), "file_info", label, params, host)
  );
}

// ---------------------------------------------------------------------------
// search_files
// ---------------------------------------------------------------------------

function registerSearchFiles(server: McpServer): void {
  server.tool(
    "search_files",
    "Filename search across a directory tree. type:\"glob\" (default, micromatch syntax) or \"regex\". Capped at 200 results; response includes truncated:true if hit.",
    {
      label: z.string(),
      pattern: z.string(),
      relative_path: z.string().optional(),
      type: z.enum(["glob", "regex"]).optional(),
      host: z.string().optional(),
    },
    { readOnlyHint: true },
    async ({ label, host, ...params }, extra) => dispatch(userId(extra), "search_files", label, params, host)
  );
}

// ---------------------------------------------------------------------------
// read_file
// ---------------------------------------------------------------------------

function registerReadFile(server: McpServer): void {
  server.tool(
    "read_file",
    "Returns file content or a specified line range. Includes total_lines. Returns a size error if the file exceeds the cap — use start_line/end_line to page, or grep_files for content search.",
    {
      label: z.string(),
      relative_path: z.string(),
      start_line: z.number().int().optional(),
      end_line: z.number().int().optional(),
      host: z.string().optional(),
    },
    { readOnlyHint: true },
    async ({ label, host, ...params }, extra) => dispatch(userId(extra), "read_file", label, params, host)
  );
}

// ---------------------------------------------------------------------------
// grep_files
// ---------------------------------------------------------------------------

function registerGrepFiles(server: McpServer): void {
  server.tool(
    "grep_files",
    "Content search. type:\"literal\" (default) or \"regex\". relative_path can be a file or directory. file_glob scopes recursive search (e.g. \"*.ts\"). Results grouped by file. Capped at 50 matches and 100KB output.",
    {
      label: z.string(),
      pattern: z.string(),
      relative_path: z.string().optional(),
      file_glob: z.string().optional(),
      type: z.enum(["literal", "regex"]).optional(),
      host: z.string().optional(),
    },
    { readOnlyHint: true },
    async ({ label, host, ...params }, extra) => dispatch(userId(extra), "grep_files", label, params, host)
  );
}

// ---------------------------------------------------------------------------
// write_file
// ---------------------------------------------------------------------------

function registerWriteFile(server: McpServer): void {
  server.tool(
    "write_file",
    "Write content to a file. mode:\"overwrite\" (default) replaces the file; \"append\" adds to it.",
    {
      label: z.string(),
      relative_path: z.string(),
      content: z.string(),
      mode: z.enum(["overwrite", "append"]).optional(),
      host: z.string().optional(),
    },
    { idempotentHint: true, destructiveHint: true },
    async ({ label, host, ...params }, extra) => dispatch(userId(extra), "write_file", label, params, host)
  );
}

// ---------------------------------------------------------------------------
// edit_file
// ---------------------------------------------------------------------------

function registerEditFile(server: McpServer): void {
  server.tool(
    "edit_file",
    "Apply a list of exact-match text substitutions. Each old_text must match exactly once — zero or multiple matches abort with edit_index and match_count. All edits validated before any write. dry_run:true returns the diff without writing.",
    {
      label: z.string(),
      relative_path: z.string(),
      edits: z.array(z.object({ old_text: z.string(), new_text: z.string() })),
      dry_run: z.boolean().optional(),
      host: z.string().optional(),
    },
    { destructiveHint: true, idempotentHint: false },
    async ({ label, host, ...params }, extra) => dispatch(userId(extra), "edit_file", label, params, host)
  );
}

// ---------------------------------------------------------------------------
// copy
// ---------------------------------------------------------------------------

function registerCopy(server: McpServer): void {
  server.tool(
    "copy",
    "Copy a file or directory within a label root. dst_label enables cross-label copy on the same host. Fails if the destination already exists.",
    {
      label: z.string(),
      src_relative_path: z.string(),
      dst_relative_path: z.string(),
      dst_label: z.string().optional(),
      host: z.string().optional(),
    },
    {},
    async ({ label, host, ...params }, extra) => dispatch(userId(extra), "copy", label, params, host)
  );
}

// ---------------------------------------------------------------------------
// create_directory
// ---------------------------------------------------------------------------

function registerCreateDirectory(server: McpServer): void {
  server.tool(
    "create_directory",
    "Create a directory and any missing parents.",
    {
      label: z.string(),
      relative_path: z.string(),
      host: z.string().optional(),
    },
    { idempotentHint: true },
    async ({ label, host, ...params }, extra) => dispatch(userId(extra), "create_directory", label, params, host)
  );
}

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

function registerDelete(server: McpServer): void {
  server.tool(
    "delete",
    "Delete a file or directory. If relative_path is a directory and recursive is absent or false, returns a summary (size, file count) asking you to confirm by re-calling with recursive:true. Always surface this confirmation to the user before proceeding.",
    {
      label: z.string(),
      relative_path: z.string(),
      recursive: z.boolean().optional(),
      host: z.string().optional(),
    },
    { destructiveHint: true, idempotentHint: false },
    async ({ label, host, ...params }, extra) => dispatch(userId(extra), "delete", label, params, host)
  );
}

// ---------------------------------------------------------------------------
// move
// ---------------------------------------------------------------------------

function registerMove(server: McpServer): void {
  server.tool(
    "move",
    "Move a file or directory. dst_label enables cross-label move on the same host.",
    {
      label: z.string(),
      src_relative_path: z.string(),
      dst_relative_path: z.string(),
      dst_label: z.string().optional(),
      host: z.string().optional(),
    },
    {},
    async ({ label, host, ...params }, extra) => dispatch(userId(extra), "move", label, params, host)
  );
}
