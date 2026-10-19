import type { OauthClient } from "./generated/prisma/client.js";
import { createLogger } from "@constellation/shared";
import { prisma } from "./db.js";
import { config } from "./config.js";
import { safeFetchJson, SafeFetchError } from "./safe-fetch.js";

const log = createLogger("oauth-clients");

// draft-ietf-oauth-client-id-metadata-document §8 recommends a 5 KB cap.
const METADATA_MAX_BYTES = 5 * 1024;
const METADATA_FETCH_TIMEOUT_MS = 5_000;
const METADATA_DEFAULT_TTL_MS = 60 * 60 * 1000;
const METADATA_MIN_TTL_MS = 5 * 60 * 1000;
const METADATA_MAX_TTL_MS = 24 * 60 * 60 * 1000;
const CLIENT_ID_URL_MAX_LENGTH = 2000;
const CLIENT_NAME_MAX_LENGTH = 200;

/** Thrown when a client cannot be resolved; the message is safe to return as error_description. */
export class InvalidClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidClientError";
  }
}

/** True when a client_id should be resolved as a Client ID Metadata Document URL. DCR ids are cuids and never match. */
export function isMetadataDocumentClientId(clientId: string): boolean {
  return clientId.startsWith("https://");
}

/**
 * Resolves the OAuth client for a client_id. For a Client ID Metadata Document URL the
 * document is fetched (or re-fetched once its cache lifetime has elapsed), validated, and
 * upserted as an OauthClient row; other ids are looked up directly.
 *
 * @returns The client row, or null when a non-URL client_id is unknown.
 * @throws InvalidClientError when a metadata document URL or its document is invalid or
 *   cannot be fetched. Fetch failures are never cached.
 */
export async function resolveOauthClient(clientId: string): Promise<OauthClient | null> {
  if (!isMetadataDocumentClientId(clientId)) {
    return prisma.oauthClient.findUnique({ where: { id: clientId } });
  }

  validateClientIdUrl(clientId);

  const cached = await prisma.oauthClient.findUnique({ where: { id: clientId } });
  if (cached?.isMetadataDocument && cached.metadataExpiresAt && cached.metadataExpiresAt > new Date()) {
    return cached;
  }

  let fetched;
  try {
    fetched = await safeFetchJson(clientId, { maxBytes: METADATA_MAX_BYTES, timeoutMs: METADATA_FETCH_TIMEOUT_MS });
  } catch (err) {
    if (err instanceof SafeFetchError) {
      log.warn({ clientId, reason: err.message }, "Client metadata document fetch failed");
      throw new InvalidClientError(`client metadata document could not be fetched: ${err.message}`);
    }
    throw err;
  }

  const metadata = parseMetadataDocument(clientId, fetched.body);
  const metadataExpiresAt = new Date(Date.now() + cacheLifetimeMs(fetched.cacheControl));
  const data = {
    redirectUris: metadata.redirectUris,
    grantTypes: metadata.grantTypes,
    clientName: metadata.clientName,
    metadataExpiresAt,
  };

  const client = await prisma.oauthClient.upsert({
    where: { id: clientId },
    create: { id: clientId, isDynamic: false, isMetadataDocument: true, clientSecretHash: null, ...data },
    update: data,
  });
  log.info({ clientId }, "Client metadata document fetched");
  return client;
}

/** Throws unless the client_id is a well-formed Client Identifier URL (CIMD draft §3). */
function validateClientIdUrl(clientId: string): void {
  if (clientId.length > CLIENT_ID_URL_MAX_LENGTH) throw new InvalidClientError("client_id URL is too long");
  let parsed: URL;
  try {
    parsed = new URL(clientId);
  } catch {
    throw new InvalidClientError("client_id is not a valid URL");
  }
  // The draft requires simple string comparison of client_ids, so only the canonical
  // serialization is accepted. This also rejects dot segments, which the parser removes.
  if (parsed.href !== clientId) throw new InvalidClientError("client_id URL must be in canonical form");
  if (parsed.username || parsed.password) throw new InvalidClientError("client_id URL must not contain userinfo");
  if (clientId.includes("#")) throw new InvalidClientError("client_id URL must not contain a fragment");
  if (parsed.pathname === "/") throw new InvalidClientError("client_id URL must contain a path");
}

interface ParsedMetadata {
  clientName: string;
  redirectUris: string[];
  grantTypes: string[];
}

/** Validates a fetched metadata document against the CIMD draft and MCP requirements. */
function parseMetadataDocument(clientId: string, body: string): ParsedMetadata {
  let doc: unknown;
  try {
    doc = JSON.parse(body);
  } catch {
    throw new InvalidClientError("client metadata document is not valid JSON");
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    throw new InvalidClientError("client metadata document must be a JSON object");
  }
  const d = doc as Record<string, unknown>;

  if (d["client_id"] !== clientId) {
    throw new InvalidClientError("client metadata document client_id does not match its URL");
  }

  const clientName = d["client_name"];
  if (typeof clientName !== "string" || clientName.trim() === "" || clientName.length > CLIENT_NAME_MAX_LENGTH) {
    throw new InvalidClientError("client metadata document must include a client_name");
  }

  if ("client_secret" in d || "client_secret_expires_at" in d) {
    throw new InvalidClientError("client metadata document must not contain client secrets");
  }
  const authMethod = d["token_endpoint_auth_method"];
  if (authMethod !== undefined && authMethod !== "none") {
    throw new InvalidClientError("token_endpoint_auth_method must be \"none\"");
  }

  const rawRedirects = d["redirect_uris"];
  if (!Array.isArray(rawRedirects) || rawRedirects.length === 0) {
    throw new InvalidClientError("client metadata document must include redirect_uris");
  }
  // Disallowed entries are dropped rather than failing the whole document, so a client
  // listing extra URIs still works for the ones this relay permits.
  const redirectUris = rawRedirects.filter((u): u is string => typeof u === "string" && isAllowedRedirectUri(u));
  if (redirectUris.length === 0) {
    throw new InvalidClientError("none of the client's redirect_uris are allowed by this relay");
  }

  const rawGrants = d["grant_types"];
  const grantTypes = Array.isArray(rawGrants)
    ? rawGrants.filter((g): g is string => typeof g === "string")
    : ["authorization_code"];

  return { clientName: clientName.trim(), redirectUris, grantTypes };
}

/** Cache lifetime from Cache-Control, clamped to configured bounds. no-store / no-cache force a re-fetch on every authorization. */
function cacheLifetimeMs(cacheControl: string | undefined): number {
  if (!cacheControl) return METADATA_DEFAULT_TTL_MS;
  const directives = cacheControl.toLowerCase().split(",").map((s) => s.trim());
  if (directives.includes("no-store") || directives.includes("no-cache")) return 0;
  const maxAge = directives.find((s) => s.startsWith("max-age="));
  if (!maxAge) return METADATA_DEFAULT_TTL_MS;
  const seconds = Number(maxAge.slice("max-age=".length));
  if (!Number.isFinite(seconds) || seconds < 0) return METADATA_DEFAULT_TTL_MS;
  return Math.min(Math.max(seconds * 1000, METADATA_MIN_TTL_MS), METADATA_MAX_TTL_MS);
}

/** Removes metadata-document clients that never completed an auth flow, on the same TTL as dynamic clients. Called periodically from index.ts. */
export async function pruneUnactivatedMetadataDocumentClients(): Promise<void> {
  const cutoff = new Date(Date.now() - config.oauthDynamicClientTtlHours * 60 * 60 * 1000);
  // Keyed on metadataExpiresAt, not createdAt: any authorization after expiry re-fetches
  // and bumps it, so a row expired for longer than the TTL has no flow in progress.
  const result = await prisma.oauthClient.deleteMany({
    where: { isMetadataDocument: true, metadataExpiresAt: { lt: cutoff }, oauthSessions: { none: {} } },
  });
  if (result.count > 0) {
    log.info({ count: result.count }, "Pruned unactivated metadata document OAuth clients");
  }
}

/** What the authorization UI must disclose about a client (MCP spec: redirect hostname MUST be shown). */
export interface ClientDisclosure {
  clientName: string | null;
  /** Host that vouches for the client's identity (the metadata document host), or null if unverified. */
  verifiedHost: string | null;
  clientId: string;
  redirectHost: string;
  isLoopbackRedirect: boolean;
}

/** Builds the disclosure shown on the consent and login pages for a resolved client and redirect URI. */
export function clientDisclosure(client: Pick<OauthClient, "id" | "clientName" | "isMetadataDocument">, redirectUri: string): ClientDisclosure {
  const redirectHost = new URL(redirectUri).hostname;
  return {
    clientName: client.clientName,
    verifiedHost: client.isMetadataDocument ? new URL(client.id).hostname : null,
    clientId: client.id,
    redirectHost,
    isLoopbackRedirect: isLoopbackHost(redirectHost),
  };
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

/**
 * Allows https: only for origins in OAUTH_ALLOWED_REDIRECT_ORIGINS, and http: only for
 * loopback addresses. All other schemes, including custom native-app schemes, are rejected.
 */
export function isAllowedRedirectUri(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  const scheme = parsed.protocol;
  if (scheme === "javascript:" || scheme === "data:" || scheme === "vbscript:") return false;
  if (scheme === "http:") {
    // Allow http only for loopback — native app dev servers on localhost.
    return isLoopbackHost(parsed.hostname);
  }
  if (scheme === "https:") {
    // Allow only origins explicitly listed in config (defaults cover documented MCP clients;
    // operators extend via OAUTH_ALLOWED_REDIRECT_ORIGINS). Prevents arbitrary redirect-URI
    // registration from being used for authorization-code phishing.
    return config.oauthAllowedRedirectOrigins.some((origin) => {
      try {
        return new URL(origin).hostname === parsed.hostname;
      } catch {
        return false;
      }
    });
  }
  return false;
}
