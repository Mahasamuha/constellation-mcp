import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Router, Request, Response, IRouter } from "express";
import { z } from "zod/v4";
import { prisma } from "./db.js";
import { routeToolCall, RouterError } from "./router.js";
import { evaluatePermissionBlob } from "@constellation/shared";
import { lookupOAuthSession } from "./middleware.js";
import { config } from "./config.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

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
  modality: z.enum(["personal", "shared"]),
  access: z.string(),
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

const FindFilesOutput = {
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

export const mcpRouter: IRouter = Router();

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

  const session = await lookupOAuthSession(token);
  if (!session) {
    const brokerUrl = process.env["BROKER_URL"] ?? "";
    res.set("WWW-Authenticate", `Bearer realm="${brokerUrl}", error="invalid_token"`);
    res.status(401).json({ error: "invalid_token" });
    return;
  }

  (req as Request & { auth: object }).auth = {
    token,
    clientId: session.mcpClientId,
    scopes: [],
    expiresAt: Math.floor(session.expiresAt.getTime() / 1000),
    extra: {
      userId: session.userId,
      userOidcSub: session.oidcSub,
      userClaims: session.lastKnownClaims ?? {},
    },
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

export function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "constellation", version });

  registerListHosts(server);
  registerListLabels(server);
  registerListDirectory(server);
  registerFileInfo(server);
  registerFindFiles(server);
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

interface UserIdentity {
  userId: string;
  userOidcSub: string | null;
  userClaims: Record<string, unknown>;
}

function identity(extra: { authInfo?: { extra?: Record<string, unknown> } }): UserIdentity {
  const e = extra.authInfo?.extra ?? {};
  const uid = e["userId"];
  if (typeof uid !== "string") throw new Error("Missing userId in auth context");
  return {
    userId: uid,
    userOidcSub: typeof e["userOidcSub"] === "string" ? e["userOidcSub"] : null,
    userClaims: (e["userClaims"] as Record<string, unknown>) ?? {},
  };
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
  id: UserIdentity,
  tool: string,
  label: string,
  params: Record<string, unknown>,
  host?: string
): Promise<ToolResult<Record<string, unknown>>> {
  const result = await routeToolCall(id.userId, tool, label, params, host, id.userOidcSub, id.userClaims);
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
      const uid = identity(extra).userId;
      const thresholdMs = config.heartbeat.intervalMs * config.heartbeat.maxMissed;

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
  const sharedDiscoveryEnabled = config.listLabelsTool === "enabled";
  const description = sharedDiscoveryEnabled
    ? "List path labels — personal labels you own and shared labels you have access to. Shared label access is evaluated optimistically and may be further restricted by the agent."
    : "List path labels, optionally filtered by host";

  server.registerTool(
    "list_labels",
    {
      title: "List Labels",
      description,
      inputSchema: { host: z.string().optional() },
      outputSchema: { labels: z.array(z.object(LabelEntry)) },
      annotations: { readOnlyHint: true },
    },
    async ({ host }, extra) => {
      const { userId, userOidcSub } = identity(extra);

      const personalLabels = await prisma.pathLabel.findMany({
        where: { userId, ...(host ? { agent: { host } } : {}) },
        include: { agent: { select: { host: true } } },
      });

      const labels: Array<{
        label: string;
        host: string;
        reported_path: string;
        modality: "personal" | "shared";
        access: string;
      }> = personalLabels.map((l) => ({
        label: l.label,
        host: l.agent.host,
        reported_path: l.reportedPath,
        modality: "personal",
        access: "read-write",
      }));

      if (sharedDiscoveryEnabled) {
        const sharedLabels = await prisma.sharedPathLabel.findMany({
          where: host ? { agent: { host } } : {},
          include: { agent: { select: { host: true } } },
        });

        for (const l of sharedLabels) {
          const blob = l.permissionBlob as { default: string; overrides?: Array<{ oidc_sub: string; access: string }> };
          const access = evaluatePermissionBlob(blob, userOidcSub);
          if (access === "none") continue;
          labels.push({
            label: l.label,
            host: l.agent.host,
            reported_path: l.reportedPath,
            modality: "shared",
            access,
          });
        }

        labels.sort((a, b) => a.label.localeCompare(b.label));
      }

      return ok({ labels });
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
    async ({ label, host, ...params }, extra) => dispatch(identity(extra), "list_directory", label, params, host)
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
    async ({ label, host, ...params }, extra) => dispatch(identity(extra), "file_info", label, params, host)
  );
}

// ---------------------------------------------------------------------------
// find_files
// ---------------------------------------------------------------------------

function registerFindFiles(server: McpServer): void {
  server.registerTool(
    "find_files",
    {
      title: "Find Files",
      description: "Find files by name using glob or regex. Use when you know part of a filename or extension. Matches filenames and paths only — does not read or search file contents. type:\"glob\" (default, micromatch syntax) or \"regex\". Capped at 200 results.",
      inputSchema: {
        label: z.string(),
        pattern: z.string(),
        relative_path: z.string().optional(),
        type: z.enum(["glob", "regex"]).optional(),
        host: z.string().optional(),
      },
      outputSchema: FindFilesOutput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ label, host, ...params }, extra) => dispatch(identity(extra), "find_files", label, params, host)
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
    async ({ label, host, ...params }, extra) => dispatch(identity(extra), "read_file", label, params, host)
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
    async ({ label, host, ...params }, extra) => dispatch(identity(extra), "grep_files", label, params, host)
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
    async ({ label, host, ...params }, extra) => dispatch(identity(extra), "write_file", label, params, host)
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
    async ({ label, host, ...params }, extra) => dispatch(identity(extra), "edit_file", label, params, host)
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
    async ({ label, host, ...params }, extra) => dispatch(identity(extra), "copy", label, params, host)
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
    async ({ label, host, ...params }, extra) => dispatch(identity(extra), "create_directory", label, params, host)
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
    async ({ label, host, ...params }, extra) => dispatch(identity(extra), "delete", label, params, host)
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
    async ({ label, host, ...params }, extra) => dispatch(identity(extra), "move", label, params, host)
  );
}
