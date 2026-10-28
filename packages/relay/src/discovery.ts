import { Router, IRouter, Request, Response, NextFunction, RequestHandler } from "express";
import { protectedResourceMetadataHandler } from "@mahasamuha/asterism-verify";
import { config } from "./config.js";
import { resourceAudience } from "./middleware.js";
import { ADMIN_SCOPE, BASE_SCOPE, REGISTER_SCOPE } from "./request-user.js";

/**
 * RFC 9728 protected-resource metadata. asterism is the authorization server; Constellation
 * only advertises itself and its scopes. `admin` and `register` need a fresh sign-in (which
 * implies step-up): they stay out of scopes_supported and are obtained through a 403
 * insufficient_scope challenge.
 */
export const discoveryRouter: IRouter = Router();

// Built on the first request: the handler validates its options on creation and needs RELAY_URL.
let handler: RequestHandler | null = null;

function metadataHandler(): RequestHandler {
  handler ??= protectedResourceMetadataHandler(
    { issuer: config.asterismIssuer, audience: resourceAudience() },
    {
      resourceName: "Constellation",
      offlineAccess: true,
      scopes: [
        { name: BASE_SCOPE, description: "Use your files through MCP tools, and manage your own nodes and shares" },
        {
          name: ADMIN_SCOPE,
          description: "Administer Constellation: register hubs, view hub-share configuration and read the admin activity log",
          freshSignIn: true,
        },
        {
          name: REGISTER_SCOPE,
          description: "Permanently connect a computer to your files (until you remove it)",
          freshSignIn: true,
        },
      ],
    },
  );
  return handler;
}

// The audience is always `${RELAY_URL}/mcp` (RELAY_URL is a bare origin), so the path is fixed.
discoveryRouter.get("/.well-known/oauth-protected-resource/mcp", (req: Request, res: Response, next: NextFunction) => {
  metadataHandler()(req, res, next);
});
