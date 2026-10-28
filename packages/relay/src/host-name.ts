import { HOST_NAME_PATTERN } from "@constellation/shared";

/**
 * The one rule for an executor host name, shared by registration and the update_host RPC.
 * The name is trimmed, then must be 1-63 characters of letters, digits, `.`, `_` or `-`.
 * Host names surface in list_hosts, /api/executors, the activity log and tool descriptions,
 * so anything else (spaces, control characters, markup) is refused rather than stored.
 */
export function validateHostName(raw: unknown): { host: string } | { error: string } {
  const host = typeof raw === "string" ? raw.trim() : "";
  if (!host) return { error: "host must be a non-empty string" };
  if (!HOST_NAME_PATTERN.test(host)) {
    return { error: "host must be 1-63 characters: letters, digits, '.', '_' or '-'" };
  }
  return { host };
}
