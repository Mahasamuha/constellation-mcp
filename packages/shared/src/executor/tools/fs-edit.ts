import { constants as fsConstants } from "node:fs";
import { createPatch } from "diff";
import { openNoFollow } from "./safe-open.js";
import { assertPathStable } from "./safe-path.js";

// ---------------------------------------------------------------------------
// edit_file
// ---------------------------------------------------------------------------

export interface Edit {
  old_text: string;
  new_text: string;
}

export interface EditFileParams {
  edits: Edit[];
  dry_run?: boolean;
  maxFileSizeKb?: number;
}

export interface EditFileResult {
  diff: string;
}

/**
 * `displayPath` is the client-supplied relative path — used only as the diff's
 * filename label, never the resolved absolute path, which would leak the
 * host's filesystem layout.
 */
export async function editFile(absolutePath: string, boundaryRoot: string, displayPath: string, params: EditFileParams): Promise<EditFileResult> {
  await assertPathStable(absolutePath, boundaryRoot);
  // dry_run only ever reads — open read-only for it so a preview against a
  // read-only-permissioned file still works, matching pre-existing behavior.
  const handle = await openNoFollow(absolutePath, params.dry_run ? fsConstants.O_RDONLY : fsConstants.O_RDWR);
  try {
    const original = await handle.readFile("utf8");
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

    if (!params.dry_run && params.maxFileSizeKb !== undefined) {
      const writeSizeKb = Buffer.byteLength(content, "utf8") / 1024;
      if (writeSizeKb > params.maxFileSizeKb) {
        throw Object.assign(
          new Error(`Edited content exceeds limit: ${Math.ceil(writeSizeKb)} KB > ${params.maxFileSizeKb} KB`),
          { code: "WRITE_TOO_LARGE", write_size_kb: Math.ceil(writeSizeKb), max_file_size_kb: params.maxFileSizeKb }
        );
      }
    }

    const diff = createPatch(displayPath, original, content);

    if (!params.dry_run) {
      // truncate then write at an explicit position 0 — handle.writeFile()
      // without O_APPEND writes from the *current* position, which is EOF
      // of the original content after the read above, not necessarily 0.
      await handle.truncate(0);
      await handle.write(content, 0, "utf8");
    }

    return { diff };
  } finally {
    await handle.close();
  }
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
