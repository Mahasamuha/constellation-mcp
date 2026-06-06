export interface PermissionBlob {
  default: string;
  overrides?: Array<{ oidc_sub: string; access: string }>;
}
