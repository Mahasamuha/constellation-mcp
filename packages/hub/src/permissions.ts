import type { AccessLevel, LabelConfig } from "./config.js";
import { evaluatePermissionBlob, type PermissionBlob } from "@constellation/shared";

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
 * Evaluates whether a user (identified by oidcSub) may invoke a tool on a
 * given label. Resolution order:
 *   1. Label must exist in admin config — users cannot access unlisted labels.
 *   2. Per-oidcSub override wins over default if present.
 *   3. Default access level applies otherwise.
 *   4. "none" always rejects; "read-only" blocks write tools; "read-write" allows all.
 */
export function checkPermission(
  userOidcSub: string | null,
  label: string,
  tool: string,
  labels: LabelConfig[]
): PermissionResult {
  const labelConfig = labels.find((l) => l.name === label);
  if (!labelConfig) {
    return { permitted: false, reason: `Label '${label}' is not in the admin label config` };
  }

  const access = evaluatePermissionBlob(labelConfig.permissions, userOidcSub) as AccessLevel;

  if (access === "none") {
    return { permitted: false, reason: `Access to label '${label}' is denied` };
  }

  if (WRITE_TOOLS.has(tool) && access === "read-only") {
    return {
      permitted: false,
      reason: `Label '${label}' is read-only; write operations are not permitted`,
    };
  }

  return { permitted: true, access };
}

export type RpcPermissionResult =
  | { permitted: true }
  | { permitted: false; label: string; reason: string };

/**
 * Evaluates permissions for an RPC, including the destination label for
 * cross-label copy/move. The source label is checked first; if it passes and
 * the request targets a different destination label (via dst_label), that
 * label is independently checked against the same tool. Without this second
 * check, write access to one label could be used to copy/move into a label
 * the user only has read (or no) access to.
 */
export function checkRpcPermission(
  userOidcSub: string | null,
  label: string,
  dstLabel: string | null,
  tool: string,
  labels: LabelConfig[]
): RpcPermissionResult {
  const result = checkPermission(userOidcSub, label, tool, labels);
  if (!result.permitted) {
    return { permitted: false, label, reason: result.reason };
  }

  if (dstLabel !== null && dstLabel !== label) {
    const dstResult = checkPermission(userOidcSub, dstLabel, tool, labels);
    if (!dstResult.permitted) {
      return { permitted: false, label: dstLabel, reason: dstResult.reason };
    }
  }

  return { permitted: true };
}

/**
 * Returns the permission blob stored in the relay for a label — used by the
 * hub when syncing labels to the relay so the relay can evaluate optimistic
 * discovery without a round-trip to the hub.
 */
export function buildPermissionBlob(label: LabelConfig): PermissionBlob {
  return {
    default: label.permissions.default,
    overrides: label.permissions.overrides,
  };
}
