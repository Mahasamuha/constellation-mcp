import { Router, Request, Response, IRouter } from "express";
import { config } from "./config.js";

export const setupRouter: IRouter = Router();

// Minimal root status document. Sign-in, accounts and consent live in asterism, so
// there is nothing to set up here.
setupRouter.get("/", (_req: Request, res: Response) => {
  const relayUrl = process.env["RELAY_URL"] ?? "";
  res.json({
    service: "constellation-relay",
    mcp_endpoint: `${relayUrl}/mcp`,
    authorization_server: config.asterismIssuer,
  });
});
