import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Router, Request, Response, IRouter } from "express";
import { z } from "zod/v4";
import { prisma } from "./db.js";
import { routeToolCall, RouterError } from "./router.js";
import { hashToken, createLogger } from "@constellation/shared";

// ---------------------------------------------------------------------------
// Output schemas — used as outputSchema in registerTool and to type ok()
// ---------------------------------------------------------------------------

const HostEntry = {
  host: z.string(),
  online: z.boolean(),
  last_seen: z.string().nullable(),
  labels: z.array(z.string()),
};

const LabelEntry = {
  label: z.string(),
  host: z.string(),
  reported_path: z.string(),
};

const DirNode = {
  path: z.string(),
  type: z.enum(["file", "directory", "symlink"]),
};

const ListDirectoryOutput = {
  nodes: z.array(z.object(DirNode)),
  total_nodes: z.number(),
  truncated: z.boolean(),
  truncated_by: z.enum(["limit", "max_depth"]).optional(),
};

const FileInfoOutput = {
  size: z.number(),
  mtime: z.string(),
  type: z.enum(["file", "directory", "symlink"]),
  target: z.string().optional(),
};

const SearchFilesOutput = {
  matches: z.array(z.string()),
  truncated: z.boolean(),
};

const ReadFileOutput = {
  content: z.string(),
  total_lines: z.number(),
};

const GrepMatch = { line: z.number(), text: z.string() };
const GrepFilesOutput = {
  results: z.array(z.object({ file: z.string(), matches: z.array(z.object(GrepMatch)) })),
  truncated: z.boolean(),
};

const OkOutput = { ok: z.literal(true) };

const EditFileOutput = { diff: z.string() };

const DeleteOutput = {
  ok: z.boolean().optional(),
  requires_confirmation: z.boolean().optional(),
  path: z.string().optional(),
  size_bytes: z.number().optional(),
  file_count: z.number().optional(),
};

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
  const authHeader = req.headers["authorization"];
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    const brokerUrl = process.env["BROKER_URL"] ?? "";
    res.set("WWW-Authenticate", `Bearer realm="${brokerUrl}", resource_metadata="${brokerUrl}/.well-known/oauth-protected-resource"`);
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const session = await resolveBearerToken(token);
  if (!session) {
    const brokerUrl = process.env["BROKER_URL"] ?? "";
    res.set("WWW-Authenticate", `Bearer realm="${brokerUrl}", error="invalid_token"`);
    res.status(401).json({ error: "invalid_token" });
    return;
  }

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
  const server = new McpServer({ name: "constellation", version: "0.1.0" });

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

function userId(extra: { authInfo?: { extra?: { userId?: unknown } } }): string {
  const id = extra.authInfo?.extra?.userId;
  if (typeof id !== "string") throw new Error("Missing userId in auth context");
  return id;
}

function isRouterError(v: unknown): v is RouterError {
  return typeof v === "object" && v !== null && "code" in v;
}

type ToolResult<T extends Record<string, unknown>> = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: T;
};

function ok<T extends Record<string, unknown>>(data: T): ToolResult<T> {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
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
): Promise<ToolResult<Record<string, unknown>>> {
  const result = await routeToolCall(uid, tool, label, params, host);
  if (isRouterError(result)) toolError(result.message);
  if (result.error) toolError(result.error.message);
  return ok(result.result as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// list_hosts
// ---------------------------------------------------------------------------

function registerListHosts(server: McpServer): void {
  server.registerTool(
    "list_hosts",
    {
      title: "List Hosts",
      description: "List all registered hosts with liveness status and their labels",
      outputSchema: { hosts: z.array(z.object(HostEntry)) },
      annotations: { readOnlyHint: true },
    },
    async (extra) => {
      const uid = userId(extra);
      const thresholdMs =
        parseInt(process.env["HEARTBEAT_INTERVAL_SECONDS"] ?? "60", 10) *
        parseInt(process.env["HEARTBEAT_MAX_MISSED"] ?? "3", 10) *
        1000;

      const agents = await prisma.agent.findMany({
        where: { userId: uid },
        include: { pathLabels: { select: { label: true } } },
      });

      return ok({ hosts: agents.map((a) => ({
        host: a.host,
        online: a.lastHeartbeatAt !== null && Date.now() - a.lastHeartbeatAt.getTime() < thresholdMs,
        last_seen: a.lastHeartbeatAt?.toISOString() ?? null,
        labels: a.pathLabels.map((pl) => pl.label),
      })) });
    }
  );
}

// ---------------------------------------------------------------------------
// list_labels
// ---------------------------------------------------------------------------

function registerListLabels(server: McpServer): void {
  server.registerTool(
    "list_labels",
    {
      title: "List Labels",
      description: "List path labels, optionally filtered by host",
      inputSchema: { host: z.string().optional() },
      outputSchema: { labels: z.array(z.object(LabelEntry)) },
      annotations: { readOnlyHint: true },
    },
    async ({ host }, extra) => {
      const uid = userId(extra);
      const labels = await prisma.pathLabel.findMany({
        where: { userId: uid, ...(host ? { agent: { host } } : {}) },
        include: { agent: { select: { host: true } } },
      });
      return ok({ labels: labels.map((l) => ({ label: l.label, host: l.agent.host, reported_path: l.reportedPath })) });
    }
  );
}

// ---------------------------------------------------------------------------
// list_directory
// ---------------------------------------------------------------------------

function registerListDirectory(server: McpServer): void {
  server.registerTool(
    "list_directory",
    {
      title: "List Directory",
      description: "Enumerate directory contents — names, types, and sizes. Use to understand folder structure or browse what files exist in a directory. Returns entries for all items in the directory, not a single path's metadata. Use recursive:true with exclude:[\"node_modules\",\".git\"] for repo trees.",
      inputSchema: {
        label: z.string(),
        relative_path: z.string().optional(),
        recursive: z.boolean().optional(),
        max_depth: z.number().int().optional(),
        limit: z.number().int().optional(),
        exclude: z.array(z.string()).optional(),
        host: z.string().optional(),
      },
      outputSchema: ListDirectoryOutput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ label, host, ...params }, extra) => dispatch(userId(extra), "list_directory", label, params, host)
  );
}

// ---------------------------------------------------------------------------
// file_info
// ---------------------------------------------------------------------------

function registerFileInfo(server: McpServer): void {
  server.registerTool(
    "file_info",
    {
      title: "File Info",
      description: "Returns metadata (size, mtime, type) for a single path. Use when you need to check if a path exists, its size, or whether it is a file vs directory — without reading its contents. Single path only — does not enumerate directory contents.",
      inputSchema: {
        label: z.string(),
        relative_path: z.string(),
        host: z.string().optional(),
      },
      outputSchema: FileInfoOutput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ label, host, ...params }, extra) => dispatch(userId(extra), "file_info", label, params, host)
  );
}

// ---------------------------------------------------------------------------
// search_files
// ---------------------------------------------------------------------------

function registerSearchFiles(server: McpServer): void {
  server.registerTool(
    "search_files",
    {
      title: "Search Files",
      description: "Find files by name using glob or regex. Use when you know part of a filename or extension. Matches filenames and paths only — does not read or search file contents. type:\"glob\" (default, micromatch syntax) or \"regex\". Capped at 200 results.",
      inputSchema: {
        label: z.string(),
        pattern: z.string(),
        relative_path: z.string().optional(),
        type: z.enum(["glob", "regex"]).optional(),
        host: z.string().optional(),
      },
      outputSchema: SearchFilesOutput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ label, host, ...params }, extra) => dispatch(userId(extra), "search_files", label, params, host)
  );
}

// ---------------------------------------------------------------------------
// read_file
// ---------------------------------------------------------------------------

function registerReadFile(server: McpServer): void {
  server.registerTool(
    "read_file",
    {
      title: "Read File",
      description: "Read the full content of a file, or a specific line range. Includes total_lines. Files that exceed the size cap return an error with total_lines — retry with start_line/end_line to page through the content. Does not search for text within files.",
      inputSchema: {
        label: z.string(),
        relative_path: z.string(),
        start_line: z.number().int().optional(),
        end_line: z.number().int().optional(),
        host: z.string().optional(),
      },
      outputSchema: ReadFileOutput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ label, host, ...params }, extra) => dispatch(userId(extra), "read_file", label, params, host)
  );
}

// ---------------------------------------------------------------------------
// grep_files
// ---------------------------------------------------------------------------

function registerGrepFiles(server: McpServer): void {
  server.registerTool(
    "grep_files",
    {
      title: "Search File Contents",
      description: "Search file contents for a literal string or regex pattern. Use to find which files contain specific text. Does not match on filenames or paths — only file contents. relative_path can be a file or directory; file_glob (e.g. \"*.ts\") scopes recursive search. Results grouped by file, capped at 50 matches and 100KB.",
      inputSchema: {
        label: z.string(),
        pattern: z.string(),
        relative_path: z.string().optional(),
        file_glob: z.string().optional(),
        type: z.enum(["literal", "regex"]).optional(),
        host: z.string().optional(),
      },
      outputSchema: GrepFilesOutput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ label, host, ...params }, extra) => dispatch(userId(extra), "grep_files", label, params, host)
  );
}

// ---------------------------------------------------------------------------
// write_file
// ---------------------------------------------------------------------------

function registerWriteFile(server: McpServer): void {
  server.registerTool(
    "write_file",
    {
      title: "Write File",
      description: "Write content to a file. Replaces the entire file by default — does not support partial edits or targeted text substitutions. mode:\"overwrite\" (default) replaces the file; \"append\" adds to it.",
      inputSchema: {
        label: z.string(),
        relative_path: z.string(),
        content: z.string(),
        mode: z.enum(["overwrite", "append"]).optional(),
        host: z.string().optional(),
      },
      outputSchema: OkOutput,
      annotations: { idempotentHint: true, destructiveHint: true, openWorldHint: true },
    },
    async ({ label, host, ...params }, extra) => dispatch(userId(extra), "write_file", label, params, host)
  );
}

// ---------------------------------------------------------------------------
// edit_file
// ---------------------------------------------------------------------------

function registerEditFile(server: McpServer): void {
  server.registerTool(
    "edit_file",
    {
      title: "Edit File",
      description: "Apply a list of exact-match text substitutions to an existing file. Modifies specific text in place — does not replace the entire file. Each old_text must match exactly once — zero or multiple matches abort with edit_index and match_count. All edits validated before any write. dry_run:true returns the diff without writing.",
      inputSchema: {
        label: z.string(),
        relative_path: z.string(),
        edits: z.array(z.object({ old_text: z.string(), new_text: z.string() })),
        dry_run: z.boolean().optional(),
        host: z.string().optional(),
      },
      outputSchema: EditFileOutput,
      annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ label, host, ...params }, extra) => dispatch(userId(extra), "edit_file", label, params, host)
  );
}

// ---------------------------------------------------------------------------
// copy
// ---------------------------------------------------------------------------

function registerCopy(server: McpServer): void {
  server.registerTool(
    "copy",
    {
      title: "Copy",
      description: "Copy a file or directory within a label root. Leaves the source intact — does not remove or rename it. dst_label enables cross-label copy on the same host. Fails if the destination already exists.",
      inputSchema: {
        label: z.string(),
        src_relative_path: z.string(),
        dst_relative_path: z.string(),
        dst_label: z.string().optional(),
        host: z.string().optional(),
      },
      outputSchema: OkOutput,
      annotations: { openWorldHint: true },
    },
    async ({ label, host, ...params }, extra) => dispatch(userId(extra), "copy", label, params, host)
  );
}

// ---------------------------------------------------------------------------
// create_directory
// ---------------------------------------------------------------------------

function registerCreateDirectory(server: McpServer): void {
  server.registerTool(
    "create_directory",
    {
      title: "Create Directory",
      description: "Create a directory and any missing parents.",
      inputSchema: {
        label: z.string(),
        relative_path: z.string(),
        host: z.string().optional(),
      },
      outputSchema: OkOutput,
      annotations: { idempotentHint: true, openWorldHint: true },
    },
    async ({ label, host, ...params }, extra) => dispatch(userId(extra), "create_directory", label, params, host)
  );
}

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

function registerDelete(server: McpServer): void {
  server.registerTool(
    "delete",
    {
      title: "Delete",
      description: "Delete a file or directory. If relative_path is a directory and recursive is absent or false, returns a summary (size, file count) asking you to confirm by re-calling with recursive:true. Always surface this confirmation to the user before proceeding.",
      inputSchema: {
        label: z.string(),
        relative_path: z.string(),
        recursive: z.boolean().optional(),
        host: z.string().optional(),
      },
      outputSchema: DeleteOutput,
      annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ label, host, ...params }, extra) => dispatch(userId(extra), "delete", label, params, host)
  );
}

// ---------------------------------------------------------------------------
// move
// ---------------------------------------------------------------------------

function registerMove(server: McpServer): void {
  server.registerTool(
    "move",
    {
      title: "Move",
      description: "Move a file or directory. Removes the source after copying — does not leave the original in place. dst_label enables cross-label move on the same host.",
      inputSchema: {
        label: z.string(),
        src_relative_path: z.string(),
        dst_relative_path: z.string(),
        dst_label: z.string().optional(),
        host: z.string().optional(),
      },
      outputSchema: OkOutput,
      annotations: { openWorldHint: true },
    },
    async ({ label, host, ...params }, extra) => dispatch(userId(extra), "move", label, params, host)
  );
}
