-- AlterTable: add optional per-label instructions text to shared path labels,
-- mirroring path_labels.instructions — populated from the shared agent's
-- labels.yaml and surfaced to MCP clients via list_labels.
ALTER TABLE "shared_path_labels" ADD COLUMN "instructions" TEXT;
