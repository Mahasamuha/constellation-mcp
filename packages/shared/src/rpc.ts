export interface RpcError {
  message: string;
  code?: string;
  /** edit_file: 0-based index of the failing edit */
  edit_index?: number;
  /** edit_file: how many times old_text matched (0 or >1) */
  match_count?: number;
  /** read_file: actual file size in KB */
  read_size_kb?: number;
  /** read_file: configured cap in KB */
  max_file_size_kb?: number;
  /** copy/move: destination path that already exists */
  path?: string;
}

export interface RpcResponse {
  request_id: string;
  result?: object;
  error?: RpcError;
}

export interface PathEntry {
  label: string;
  path: string;
  context_file?: string;
  instructions?: string;
}

/** Maximum length for a label's `instructions` text, regardless of source (inline or context_file). Longer values are dropped (logged as a warning) rather than truncated. */
export const MAX_LABEL_INSTRUCTIONS_LENGTH = 500;
