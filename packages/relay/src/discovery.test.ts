import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";

vi.mock("./db.js", () => ({ prisma: {} }));
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { protectedResourceMetadataPath } from "@mahasamuha/asterism-verify";
import { discoveryRouter } from "./discovery.js";

describe("discoveryRouter", () => {
  const prev = process.env["RELAY_URL"];
  let server: Server;
  let base: string;

  beforeAll(async () => {
    process.env["RELAY_URL"] = "https://relay.example.com";
    const app = express();
    app.use(discoveryRouter);
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
    if (prev === undefined) delete process.env["RELAY_URL"];
    else process.env["RELAY_URL"] = prev;
  });

  it("serves RFC 9728 metadata at the path for the /mcp audience", async () => {
    expect(protectedResourceMetadataPath("https://relay.example.com/mcp")).toBe(
      "/.well-known/oauth-protected-resource/mcp",
    );
    const res = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["resource"]).toBe("https://relay.example.com/mcp");
    expect(body["resource_name"]).toBe("Constellation");
    expect(body["scopes_supported"]).toEqual(["relay", "offline_access"]);
    expect(body["asterism_scopes"]).toEqual([
      expect.objectContaining({ name: "relay" }),
      expect.objectContaining({ name: "admin", step_up: true }),
    ]);
  });

  it("does not serve the old root documents", async () => {
    expect((await fetch(`${base}/.well-known/oauth-protected-resource`)).status).toBe(404);
    expect((await fetch(`${base}/.well-known/oauth-authorization-server`)).status).toBe(404);
  });
});
