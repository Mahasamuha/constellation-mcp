import { Router, Request, Response, IRouter } from "express";
import { requireEnv } from "@constellation/shared";

/**
 * OAuth Client ID Metadata Documents (CIMD) for Constellation's own device-flow clients.
 * asterism accepts only CIMD clients: the client_id is the https URL of one of these
 * documents, which asterism fetches (no redirects, 5 KB cap) when a client first asks
 * for a device code.
 *
 * Three separate clients because asterism keeps one grant per (user, client, resource):
 * with one shared client, a refresh-token reuse detection or a revoke in /grants for
 * the CLI would also end every node and hub.
 *
 * The path segment per kind is mirrored by clientIdFor() in @constellation/shared.
 */
const CLIENTS = {
  cli: "Constellation CLI",
  node: "Constellation node",
  hub: "Constellation hub",
} as const;

/** Path of the placeholder redirect URI. Nothing may ever be routed here. */
export const NO_REDIRECT_PATH = "/clients/no-redirect";

export const clientMetadataRouter: IRouter = Router();

/** Builds the CIMD document for `kind`, whose client_id is the URL it is served from. */
export function clientMetadata(relayUrl: string, kind: keyof typeof CLIENTS) {
  return {
    client_id: `${relayUrl}/clients/${kind}.json`,
    client_name: CLIENTS[kind],
    grant_types: ["authorization_code", "urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
    response_types: ["code"],
    // Never used: these clients only run the device flow, but asterism requires a non-empty
    // list. An https URI on the relay that is never served (see NO_REDIRECT_PATH), so an
    // authorization-code redirect can't land on anything, unlike a loopback port that any
    // local process could listen on.
    redirect_uris: [`${relayUrl}${NO_REDIRECT_PATH}`],
    token_endpoint_auth_method: "none",
  };
}

for (const kind of Object.keys(CLIENTS) as Array<keyof typeof CLIENTS>) {
  clientMetadataRouter.get(`/clients/${kind}.json`, (_req: Request, res: Response) => {
    res.set("Cache-Control", "public, max-age=3600");
    res.json(clientMetadata(requireEnv("RELAY_URL"), kind));
  });
}
