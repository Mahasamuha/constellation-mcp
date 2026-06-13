-- AlterTable: add optional per-label instructions text, populated from the
-- agent's context_file at config_update time and surfaced to MCP clients via
-- list_labels (replacing reported_path, which is internal-only).
ALTER TABLE "path_labels" ADD COLUMN "instructions" TEXT;
