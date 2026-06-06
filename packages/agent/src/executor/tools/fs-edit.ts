import { promises as fs } from "node:fs";
import { join } from "node:path";
import { createPatch } from "diff";

// ---------------------------------------------------------------------------
// edit_file
// ---------------------------------------------------------------------------

export interface Edit {
  old_text: string;
  new_text: string;
}

export interface EditFileParams {
  relative_path: string;
  edits: Edit[];
  dry_run?: boolean;
}

export interface EditFileResult {
  diff: string;
}

export async function editFile(root: string, params: EditFileParams): Promise<EditFileResult> {
  const full = join(root, params.relative_path);
  const original = await fs.readFile(full, "utf8");
  let content = original;

  for (let i = 0; i < params.edits.length; i++) {
    const edit = params.edits[i]!;
    const count = countOccurrences(content, edit.old_text);
    if (count === 0) {
      throw Object.assign(
        new Error(`No match found for edit ${i} — fetch current file content and retry`),
        { code: "EDIT_NO_MATCH", edit_index: i, match_count: 0 }
      );
    }
    if (count > 1) {
      throw Object.assign(
        new Error(`${count} matches found for edit ${i} — expand old_text to include more surrounding context`),
        { code: "EDIT_AMBIGUOUS", edit_index: i, match_count: count }
      );
    }
    content = content.replace(edit.old_text, () => edit.new_text);
  }

  const diff = createPatch(params.relative_path, original, content);

  if (!params.dry_run) {
    await fs.writeFile(full, content, "utf8");
  }

  return { diff };
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++;
    pos += needle.length;
  }
  return count;
}
