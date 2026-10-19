import { request, type RequestOptions } from "node:https";
import type { IncomingMessage } from "node:http";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";

/** Thrown when a guarded fetch is refused or fails; the message is safe to surface to clients. */
export class SafeFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafeFetchError";
  }
}

// IANA special-purpose address registries (IPv4 and IPv6). Anything here is refused,
// including ranges that are technically routable (6to4, Teredo, NAT64), since none of
// them is a legitimate host for a client metadata document.
const SPECIAL_USE_IPV4: Array<[string, number]> = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];
const SPECIAL_USE_IPV6: Array<[string, number]> = [
  // ::ffff:0:0/96 (IPv4-mapped) is deliberately absent: BlockList already checks mapped
  // addresses against the IPv4 rules, and listing it would match every IPv4 address.
  // ::/96 covers "::", "::1" and the deprecated IPv4-compatible form (e.g. ::7f00:1).
  ["::", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48],
  ["100::", 64], ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20],
  ["5f00::", 16], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
];

const specialUse = new BlockList();
for (const [net, prefix] of SPECIAL_USE_IPV4) specialUse.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of SPECIAL_USE_IPV6) specialUse.addSubnet(net, prefix, "ipv6");

export function isSpecialUse(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  return specialUse.check(address, family === 6 ? "ipv6" : "ipv4");
}

// Validates the addresses the socket will actually connect to, so a DNS answer that
// changes between a pre-check and connect (rebinding) cannot bypass the block list.
// Node's autoSelectFamily calls this with all: true and expects an address array back.
const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses: LookupAddress[]) => {
    if (err) {
      callback(err, "", 0);
      return;
    }
    if (addresses.length === 0 || addresses.some((a) => isSpecialUse(a.address))) {
      callback(new SafeFetchError("host resolves to a disallowed address"), "", 0);
      return;
    }
    if (options.all) {
      (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, addresses);
    } else {
      callback(null, addresses[0]!.address, addresses[0]!.family);
    }
  });
};

export interface SafeFetchResult {
  body: string;
  cacheControl: string | undefined;
}

/**
 * GETs an HTTPS URL for a JSON document with SSRF protections: refuses special-use
 * IP addresses (checked at connect time), never follows redirects, requires a 200
 * with a JSON content type, and caps the body size and total request time.
 *
 * @throws SafeFetchError on any refusal, network failure, or non-conforming response.
 */
export async function safeFetchJson(url: string, opts: { maxBytes: number; timeoutMs: number }): Promise<SafeFetchResult> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new SafeFetchError("only https URLs may be fetched");

  // Node skips the lookup function entirely for IP-literal hosts, so check them here.
  const literalHost = parsed.hostname.replace(/^\[|\]$/g, "");
  if (isIP(literalHost) !== 0 && isSpecialUse(literalHost)) {
    throw new SafeFetchError("host is a disallowed address");
  }

  const requestOptions: RequestOptions = {
    method: "GET",
    headers: { Accept: "application/json", "User-Agent": "constellation-relay" },
    lookup: guardedLookup,
    agent: false,
    signal: AbortSignal.timeout(opts.timeoutMs),
  };

  let res: IncomingMessage;
  try {
    res = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = request(parsed, requestOptions, resolve);
      req.on("error", reject);
      req.end();
    });
  } catch (err) {
    if (err instanceof SafeFetchError) throw err;
    throw new SafeFetchError("fetch failed");
  }

  try {
    if (res.statusCode !== 200) {
      throw new SafeFetchError(`unexpected HTTP status ${res.statusCode ?? "unknown"}`);
    }
    const contentType = res.headers["content-type"] ?? "";
    if (!/^application\/([\w.+-]+\+)?json\s*(;|$)/i.test(contentType)) {
      throw new SafeFetchError("response is not JSON");
    }
    const declaredLength = Number(res.headers["content-length"]);
    if (Number.isFinite(declaredLength) && declaredLength > opts.maxBytes) {
      throw new SafeFetchError("response too large");
    }

    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for await (const chunk of res as AsyncIterable<Buffer>) {
        total += chunk.length;
        if (total > opts.maxBytes) throw new SafeFetchError("response too large");
        chunks.push(chunk);
      }
    } catch (err) {
      if (err instanceof SafeFetchError) throw err;
      throw new SafeFetchError("fetch failed");
    }

    return { body: Buffer.concat(chunks).toString("utf8"), cacheControl: res.headers["cache-control"] };
  } finally {
    res.destroy();
  }
}
