import type { AccessLevel, ShareConfig } from "./config.js";
import { evaluatePermissionBlob, type PermissionBlob, type PermissionSubject } from "@constellation/shared";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PermissionResult =
  | { permitted: true; access: AccessLevel }
  | { permitted: false; reason: string };

// Tools that require write access (all others are read-only)
const WRITE_TOOLS = new Set([
  "write_file",
  "edit_file",
  "create_directory",
  "delete",
  "move",
  "copy",
]);

// ---------------------------------------------------------------------------
// Permission evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluates whether a user (identified by asterism sub and groups) may invoke a tool on a
 * given share. Resolution order:
 *   1. Share must exist in admin config — users cannot access unlisted shares.
 *   2. A per-sub override wins outright if present.
 *   3. Otherwise the most permissive matching group override applies.
 *   4. Otherwise the default access level applies.
 *   5. Anything but "read-only" or "read-write" (including "none") rejects; "read-only" blocks write tools; "read-write" allows all.
 */
export function checkPermission(
  subject: PermissionSubject,
  share: string,
  tool: string,
  shares: ShareConfig[]
): PermissionResult {
  const shareConfig = shares.find((s) => s.name === share);
  if (!shareConfig) {
    return { permitted: false, reason: `Share '${share}' is not in the admin share config` };
  }

  const access = evaluatePermissionBlob(shareConfig.permissions, subject) as AccessLevel;

  // Allowlist rather than special-casing "none": anything unrecognised is denied.
  if (access !== "read-only" && access !== "read-write") {
    return { permitted: false, reason: `Access to share '${share}' is denied` };
  }

  if (WRITE_TOOLS.has(tool) && access === "read-only") {
    return {
      permitted: false,
      reason: `Share '${share}' is read-only; write operations are not permitted`,
    };
  }

  return { permitted: true, access };
}

export type RpcPermissionResult =
  | { permitted: true }
  | { permitted: false; share: string; reason: string };

/**
 * Evaluates permissions for an RPC, including the destination share for
 * cross-share copy/move. The source share is checked first; if it passes and
 * the request targets a different destination share (via dst_share), that
 * share is independently checked against the same tool. Without this second
 * check, write access to one share could be used to copy/move into a share
 * the user only has read (or no) access to.
 */
export function checkRpcPermission(
  subject: PermissionSubject,
  share: string,
  dstShare: string | null,
  tool: string,
  shares: ShareConfig[]
): RpcPermissionResult {
  const result = checkPermission(subject, share, tool, shares);
  if (!result.permitted) {
    return { permitted: false, share, reason: result.reason };
  }

  if (dstShare !== null && dstShare !== share) {
    const dstResult = checkPermission(subject, dstShare, tool, shares);
    if (!dstResult.permitted) {
      return { permitted: false, share: dstShare, reason: dstResult.reason };
    }
  }

  return { permitted: true };
}

/**
 * Returns the permission blob stored in the relay for a share — used by the
 * hub when syncing shares to the relay so the relay can evaluate optimistic
 * discovery without a round-trip to the hub.
 */
export function buildPermissionBlob(share: ShareConfig): PermissionBlob {
  return {
    default: share.permissions.default,
    overrides: share.permissions.overrides,
  };
}
