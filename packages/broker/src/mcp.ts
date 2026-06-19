import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Router, Request, Response, IRouter } from "express";
import { z } from "zod/v4";
import { prisma } from "./db.js";
import { routeToolCall, RouterError } from "./router.js";
import { isOnline } from "./api.js";
import { evaluatePermissionBlob, requireEnv } from "@constellation/shared";
import { lookupOAuthSession } from "./middleware.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

// Inlined constellation-favicon.svg (assets/logo/) — surfaced as the icon for
// the MCP server itself and for the file browser tool/resource.
const CONSTELLATION_ICON = {
  src: "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMzIiIGhlaWdodD0iMzIiIHZpZXdCb3g9IjAgMCAzMiAzMiIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48dGl0bGU+Q29uc3RlbGxhdGlvbjwvdGl0bGU+PHJlY3Qgd2lkdGg9IjMyIiBoZWlnaHQ9IjMyIiByeD0iNyIgZmlsbD0iIzFBMUEyRSIvPjxnIHN0cm9rZT0iIzVEQ0FBNSIgc3Ryb2tlLXdpZHRoPSIxLjQiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgZmlsbD0ibm9uZSIgb3BhY2l0eT0iMC43Ij48bGluZSB4MT0iNSIgIHkxPSIxNyIgeDI9IjEyIiB5Mj0iNSIvPjxsaW5lIHgxPSIxMiIgeTE9IjUiICB4Mj0iMjQiIHkyPSI3Ii8+PGxpbmUgeDE9IjI0IiB5MT0iNyIgIHgyPSIyOCIgeTI9IjE2Ii8+PGxpbmUgeDE9IjI4IiB5MT0iMTYiIHgyPSIyNCIgeTI9IjI1Ii8+PGxpbmUgeDE9IjI0IiB5MT0iMjUiIHgyPSIxMyIgeTI9IjI4Ii8+PGxpbmUgeDE9IjEzIiB5MT0iMjgiIHgyPSI1IiAgeTI9IjE3Ii8+PGxpbmUgeDE9IjUiICB5MT0iMTciIHgyPSIxOCIgeTI9IjE2Ii8+PGxpbmUgeDE9IjEyIiB5MT0iNSIgIHgyPSIxOCIgeTI9IjE2Ii8+PGxpbmUgeDE9IjI4IiB5MT0iMTYiIHgyPSIxOCIgeTI9IjE2Ii8+PGxpbmUgeDE9IjEzIiB5MT0iMjgiIHgyPSIxOCIgeTI9IjE2Ii8+PC9nPjxjaXJjbGUgY3g9IjUiICBjeT0iMTciIHI9IjIuNSIgZmlsbD0iIzVEQ0FBNSIvPjxjaXJjbGUgY3g9IjEyIiBjeT0iNSIgIHI9IjIuNSIgZmlsbD0iIzVEQ0FBNSIvPjxjaXJjbGUgY3g9IjI0IiBjeT0iNyIgIHI9IjIiICAgZmlsbD0iIzVEQ0FBNSIvPjxjaXJjbGUgY3g9IjI4IiBjeT0iMTYiIHI9IjMiICAgZmlsbD0iIzVEQ0FBNSIvPjxjaXJjbGUgY3g9IjI0IiBjeT0iMjUiIHI9IjIiICAgZmlsbD0iIzVEQ0FBNSIvPjxjaXJjbGUgY3g9IjEzIiBjeT0iMjgiIHI9IjIuNSIgZmlsbD0iIzVEQ0FBNSIvPjxjaXJjbGUgY3g9IjE4IiBjeT0iMTYiIHI9IjQuNSIgZmlsbD0iIzVEQ0FBNSIvPjxjaXJjbGUgY3g9IjE4IiBjeT0iMTYiIHI9IjIuMiIgZmlsbD0iIzJBNkI1OCIvPjwvc3ZnPg==",
  mimeType: "image/svg+xml",
  sizes: ["any"],
};

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
  instructions: z.string().nullable(),
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

const OpenFileBrowserOutput = {
  label: z.string().nullable(),
  path: z.string().nullable(),
};

// MCP Apps tool visibility — see plans/broker-file-viewer.md "Tool Visibility"
const VISIBLE_TO_MODEL_AND_APP = { ui: { visibility: ["model", "app"] } };
const VISIBLE_TO_MODEL_ONLY = { ui: { visibility: ["model"] } };

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
    const brokerUrl = requireEnv("BROKER_URL");
    res.set("WWW-Authenticate", `Bearer realm="${brokerUrl}", resource_metadata="${brokerUrl}/.well-known/oauth-protected-resource"`);
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const session = await lookupOAuthSession(token);
  if (!session) {
    const brokerUrl = requireEnv("BROKER_URL");
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
  const server = new McpServer({ name: "constellation", version, icons: [CONSTELLATION_ICON] });

  registerListHosts(server);
  registerListLabels(server);
  registerOpenFileBrowser(server);
  registerFileBrowserResource(server);
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
      _meta: VISIBLE_TO_MODEL_ONLY,
    },
    async (extra) => {
      const { userId, userOidcSub } = identity(extra);

      const [personalAgents, sharedLabels] = await Promise.all([
        prisma.agent.findMany({
          where: { userId },
          include: { pathLabels: { select: { label: true } } },
        }),
        prisma.sharedPathLabel.findMany({
          include: { agent: { select: { id: true, host: true, lastHeartbeatAt: true } } },
        }),
      ]);

      // Group accessible shared labels by agent
      const sharedAgentMap = new Map<string, { host: string; lastHeartbeatAt: Date | null; labels: string[] }>();
      for (const sl of sharedLabels) {
        const blob = sl.permissionBlob as { default: string; overrides?: Array<{ oidc_sub: string; access: string }> };
        if (evaluatePermissionBlob(blob, userOidcSub) === "none") continue;
        const entry = sharedAgentMap.get(sl.agentId);
        if (entry) {
          entry.labels.push(sl.label);
        } else {
          sharedAgentMap.set(sl.agentId, {
            host: sl.agent.host,
            lastHeartbeatAt: sl.agent.lastHeartbeatAt,
            labels: [sl.label],
          });
        }
      }

      return ok({
        hosts: [
          ...personalAgents.map((a) => ({
            host: a.host,
            online: isOnline(a.lastHeartbeatAt),
            last_seen: a.lastHeartbeatAt?.toISOString() ?? null,
            labels: a.pathLabels.map((pl) => pl.label),
          })),
          ...[...sharedAgentMap.values()].map((a) => ({
            host: a.host,
            online: isOnline(a.lastHeartbeatAt),
            last_seen: a.lastHeartbeatAt?.toISOString() ?? null,
            labels: a.labels,
          })),
        ],
      });
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
      description: "List path labels — personal labels you own and shared labels you have access to. Shared label access is evaluated optimistically and may be further restricted by the agent.",
      inputSchema: { host: z.string().optional() },
      outputSchema: { labels: z.array(z.object(LabelEntry)) },
      annotations: { readOnlyHint: true },
      _meta: VISIBLE_TO_MODEL_AND_APP,
    },
    async ({ host }, extra) => {
      const { userId, userOidcSub } = identity(extra);

      const [personalLabels, sharedLabels] = await Promise.all([
        prisma.pathLabel.findMany({
          where: { userId, ...(host ? { agent: { host } } : {}) },
          include: { agent: { select: { host: true } } },
        }),
        prisma.sharedPathLabel.findMany({
          where: host ? { agent: { host } } : {},
          include: { agent: { select: { host: true } } },
        }),
      ]);

      const labels: Array<{
        label: string;
        host: string;
        instructions: string | null;
        modality: "personal" | "shared";
        access: string;
      }> = personalLabels.map((l) => ({
        label: l.label,
        host: l.agent.host,
        instructions: l.instructions,
        modality: "personal",
        access: "read-write",
      }));

      for (const l of sharedLabels) {
        const blob = l.permissionBlob as { default: string; overrides?: Array<{ oidc_sub: string; access: string }> };
        const access = evaluatePermissionBlob(blob, userOidcSub);
        if (access === "none") continue;
        labels.push({
          label: l.label,
          host: l.agent.host,
          instructions: l.instructions,
          modality: "shared",
          access,
        });
      }

      labels.sort((a, b) => a.label.localeCompare(b.label));

      return ok({ labels });
    }
  );
}

// ---------------------------------------------------------------------------
// open_file_browser — MCP Apps trigger tool
// ---------------------------------------------------------------------------

function registerOpenFileBrowser(server: McpServer): void {
  server.registerTool(
    "open_file_browser",
    {
      title: "Open File Browser",
      description: "Opens an interactive file browser for the given label. Use to let the user navigate, view, and edit files inline.",
      inputSchema: {
        label: z.string().optional(),
        path: z.string().optional(),
      },
      outputSchema: OpenFileBrowserOutput,
      annotations: { readOnlyHint: true, openWorldHint: true },
      _meta: {
        ui: {
          resourceUri: "ui://constellation/file-browser",
          visibility: ["model", "app"],
        },
      },
    },
    async ({ label, path }, extra) => {
      if (!label) return ok({ label: null, path: null });

      const listing = await dispatch(identity(extra), "list_directory", label, path ? { relative_path: path } : {});
      return {
        content: [
          { type: "text", text: `Opened file browser for label "${label}"${path ? ` at ${path}` : ""}.` },
          ...listing.content,
        ],
        structuredContent: { label, path: path ?? null },
      };
    }
  );
}

// ---------------------------------------------------------------------------
// ui://constellation/file-browser — MCP Apps UI resource
// ---------------------------------------------------------------------------

// Bundled single-file React app from packages/telescope, copied to packages/broker/ui/app.html
// at Docker build time. Read lazily (and cached) so importing this module — e.g. in
// tests — doesn't require the UI bundle to have been built first.
let fileBrowserHtml: string | null = null;

function getFileBrowserHtml(): string {
  fileBrowserHtml ??= readFileSync(new URL("../ui/app.html", import.meta.url), "utf-8");
  return fileBrowserHtml;
}

function registerFileBrowserResource(server: McpServer): void {
  server.registerResource(
    "file-browser-ui",
    "ui://constellation/file-browser",
    {
      title: "Constellation File Browser",
      description: "Interactive file browser UI for browsing and editing files within Constellation labels",
      mimeType: "text/html;profile=mcp-app",
      icons: [CONSTELLATION_ICON],
      _meta: {
        ui: {
          prefersBorder: false,
        },
      },
    },
    (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/html;profile=mcp-app",
          text: getFileBrowserHtml(),
        },
      ],
    })
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
      _meta: VISIBLE_TO_MODEL_AND_APP,
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
      _meta: VISIBLE_TO_MODEL_AND_APP,
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
      _meta: VISIBLE_TO_MODEL_AND_APP,
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
      _meta: VISIBLE_TO_MODEL_AND_APP,
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
      _meta: VISIBLE_TO_MODEL_AND_APP,
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
      _meta: VISIBLE_TO_MODEL_AND_APP,
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
      _meta: VISIBLE_TO_MODEL_ONLY,
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
      _meta: VISIBLE_TO_MODEL_ONLY,
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
      _meta: VISIBLE_TO_MODEL_ONLY,
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
      _meta: VISIBLE_TO_MODEL_ONLY,
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
      _meta: VISIBLE_TO_MODEL_ONLY,
    },
    async ({ label, host, ...params }, extra) => dispatch(identity(extra), "move", label, params, host)
  );
}
