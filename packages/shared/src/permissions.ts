export interface PermissionBlob {
  default: string;
  overrides?: Array<{ oidc_sub: string; access: string }>;
}

export function evaluatePermissionBlob(blob: PermissionBlob, userOidcSub?: string | null): string {
  if (userOidcSub && blob.overrides) {
    const override = blob.overrides.find((o) => o.oidc_sub === userOidcSub);
    if (override) return override.access;
  }
  return blob.default || "none";
}
