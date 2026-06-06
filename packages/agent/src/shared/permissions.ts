import type { AccessLevel, LabelConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PermissionResult =
  | { permitted: true; access: AccessLevel; labelPath: string }
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

  let access: AccessLevel = labelConfig.permissions.default;

  if (userOidcSub) {
    const override = labelConfig.permissions.overrides.find((o) => o.oidc_sub === userOidcSub);
    if (override) access = override.access;
  }

  if (access === "none") {
    return { permitted: false, reason: `Access to label '${label}' is denied` };
  }

  if (WRITE_TOOLS.has(tool) && access === "read-only") {
    return {
      permitted: false,
      reason: `Label '${label}' is read-only; write operations are not permitted`,
    };
  }

  return { permitted: true, access, labelPath: labelConfig.path };
}

/**
 * Returns the permission blob stored in the broker for a label — used by the
 * shared agent when syncing labels to the broker so the broker can evaluate
 * optimistic discovery without a round-trip to the agent.
 */
export function buildPermissionBlob(label: LabelConfig): object {
  return {
    default: label.permissions.default,
    overrides: label.permissions.overrides,
  };
}
