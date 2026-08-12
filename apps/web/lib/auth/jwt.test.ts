import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import type { JWK, KeyLike } from "jose";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The JWKS location is discovered, not assumed.
 *
 * `${issuer}/jwks/` used to be hardcoded here. That is an Authentik
 * convention — EntraID serves its keys at
 * `https://login.microsoftonline.com/{tenant}/discovery/v2.0/keys`, so on
 * EntraID the hardcoded path 404s and NO MCP token can ever verify. These
 * tests pin the three behaviours that make the discovery path safe to ship:
 * discovery is honoured, failure degrades to the old path rather than to a
 * broken deployment, and it happens once rather than per request.
 *
 * A real loopback HTTP server is used rather than a `fetch` mock because jose
 * fetches the key set through `node:http` directly, not through global
 * `fetch` — a mocked `fetch` would silently never be consulted for the JWKS
 * request, and the assertion about *which* URL was used would prove nothing.
 */

const TENANT = "11111111-2222-3333-4444-555555555555";
const AUDIENCE = "99999999-8888-7777-6666-555555555555";

/** Paths the fake IdP was asked for, in order. */
let requested: string[] = [];
/** Response the fake IdP gives for the discovery document. */
let discoveryResponse: { status: number; body: string };
let server: Server;
let origin: string;
let privateKey: KeyLike;
let publicJwk: JWK;

/** Authentik-shaped issuer: application-scoped path, trailing slash. */
function authentikIssuer(): string {
  return `${origin}/application/o/shared-memory-mcp/`;
}

/** EntraID-shaped issuer: tenant-scoped, no trailing slash. */
function entraIssuer(): string {
  return `${origin}/${TENANT}/v2.0`;
}

/** Where an EntraID discovery document points for keys. */
function entraKeysPath(): string {
  return `/${TENANT}/discovery/v2.0/keys`;
}

beforeEach(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: "test-key", alg: "RS256", use: "sig" };
  requested = [];

  server = createServer((req, res) => {
    requested.push(req.url ?? "");
    if (req.url?.endsWith("/.well-known/openid-configuration")) {
      res.writeHead(discoveryResponse.status, { "content-type": "application/json" });
      res.end(discoveryResponse.body);
      return;
    }
    // Every other path is treated as a key set endpoint. Which path the
    // request actually arrived on is the thing under test.
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ keys: [publicJwk] }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  // The key set is memoised on globalThis, which survives vi.resetModules().
  // Without clearing it, the second test in this file would silently reuse
  // the first test's resolution and assert nothing.
  delete (globalThis as Record<string, unknown>).__sharedMemoryJwks;
  delete (globalThis as Record<string, unknown>).__sharedMemoryJwksRetryAt;
  delete process.env.OIDC_ISSUER_MCP;
  delete process.env.OIDC_AUDIENCE;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/**
 * Import `authenticateBearer` fresh so it observes the env vars this test set
 * (lib/env.ts caches its parse in a module singleton).
 */
async function loadAuthenticateBearer() {
  vi.resetModules();
  const mod = await import("@/lib/auth/jwt");
  return mod.authenticateBearer;
}

async function signAccessToken(issuer: string): Promise<string> {
  return new SignJWT({ groups: ["memory-users"] })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(issuer)
    .setAudience(AUDIENCE)
    .setSubject("user-object-id")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

function discoveryPathsSeen(): string[] {
  return requested.filter((p) => p.endsWith("/.well-known/openid-configuration"));
}

describe("MCP JWKS resolution", () => {
  test("uses the jwks_uri from discovery, so EntraID's key endpoint is reached", async () => {
    process.env.OIDC_ISSUER_MCP = entraIssuer();
    process.env.OIDC_AUDIENCE = AUDIENCE;
    discoveryResponse = {
      status: 200,
      // Shape of https://login.microsoftonline.com/{tenant}/v2.0/.well-known/openid-configuration
      body: JSON.stringify({
        issuer: entraIssuer(),
        jwks_uri: `${origin}${entraKeysPath()}`,
        token_endpoint: `${origin}/${TENANT}/oauth2/v2.0/token`,
      }),
    };

    const authenticateBearer = await loadAuthenticateBearer();
    const claims = await authenticateBearer(`Bearer ${await signAccessToken(entraIssuer())}`);

    expect(claims.sub).toBe("user-object-id");
    expect(requested).toContain(entraKeysPath());
    // The Authentik convention must NOT have been tried.
    expect(requested).not.toContain(`/${TENANT}/v2.0/jwks/`);
  });

  test("tolerates a trailing slash on the issuer while still honouring discovery", async () => {
    // acceptedIssuers() takes both spellings; discovery must not regress that.
    process.env.OIDC_ISSUER_MCP = `${entraIssuer()}/`;
    process.env.OIDC_AUDIENCE = AUDIENCE;
    discoveryResponse = {
      status: 200,
      body: JSON.stringify({ jwks_uri: `${origin}${entraKeysPath()}` }),
    };

    const authenticateBearer = await loadAuthenticateBearer();
    // Token carries the un-slashed spelling; the env var carries the slashed one.
    const claims = await authenticateBearer(`Bearer ${await signAccessToken(entraIssuer())}`);

    expect(claims.sub).toBe("user-object-id");
    expect(requested).toContain(entraKeysPath());
  });

  test("falls back to ${issuer}/jwks/ when discovery is unreachable", async () => {
    process.env.OIDC_ISSUER_MCP = authentikIssuer();
    process.env.OIDC_AUDIENCE = AUDIENCE;
    discoveryResponse = { status: 500, body: "upstream exploded" };

    const authenticateBearer = await loadAuthenticateBearer();
    const claims = await authenticateBearer(`Bearer ${await signAccessToken(authentikIssuer())}`);

    // Existing Authentik deployments keep working with no discovery document.
    expect(claims.sub).toBe("user-object-id");
    expect(requested).toContain("/application/o/shared-memory-mcp/jwks/");
  });

  test("falls back to ${issuer}/jwks/ when discovery omits jwks_uri", async () => {
    process.env.OIDC_ISSUER_MCP = authentikIssuer();
    process.env.OIDC_AUDIENCE = AUDIENCE;
    // 200 OK, valid JSON, no usable key set pointer — the malformed case that
    // a naive `doc.jwks_uri` read would turn into `new URL(undefined)`.
    discoveryResponse = { status: 200, body: JSON.stringify({ issuer: authentikIssuer() }) };

    const authenticateBearer = await loadAuthenticateBearer();
    const claims = await authenticateBearer(`Bearer ${await signAccessToken(authentikIssuer())}`);

    expect(claims.sub).toBe("user-object-id");
    expect(requested).toContain("/application/o/shared-memory-mcp/jwks/");
  });

  test("falls back when discovery returns non-JSON", async () => {
    process.env.OIDC_ISSUER_MCP = authentikIssuer();
    process.env.OIDC_AUDIENCE = AUDIENCE;
    discoveryResponse = { status: 200, body: "<html>login page</html>" };

    const authenticateBearer = await loadAuthenticateBearer();
    const claims = await authenticateBearer(`Bearer ${await signAccessToken(authentikIssuer())}`);

    expect(claims.sub).toBe("user-object-id");
    expect(requested).toContain("/application/o/shared-memory-mcp/jwks/");
  });

  test("discovers once across many verifications, not once per request", async () => {
    // The MCP endpoint verifies a token on essentially every request. A
    // discovery fetch per request would add a round-trip to every tool call.
    process.env.OIDC_ISSUER_MCP = entraIssuer();
    process.env.OIDC_AUDIENCE = AUDIENCE;
    discoveryResponse = {
      status: 200,
      body: JSON.stringify({ jwks_uri: `${origin}${entraKeysPath()}` }),
    };

    const authenticateBearer = await loadAuthenticateBearer();
    for (let i = 0; i < 3; i++) {
      await authenticateBearer(`Bearer ${await signAccessToken(entraIssuer())}`);
    }

    expect(discoveryPathsSeen()).toHaveLength(1);
  });

  test("concurrent cold requests share a single discovery fetch", async () => {
    // Caching the settled value rather than the in-flight promise would let
    // every request that arrives before the first one resolves start its own
    // discovery fetch — a thundering herd at process start.
    process.env.OIDC_ISSUER_MCP = entraIssuer();
    process.env.OIDC_AUDIENCE = AUDIENCE;
    discoveryResponse = {
      status: 200,
      body: JSON.stringify({ jwks_uri: `${origin}${entraKeysPath()}` }),
    };

    const authenticateBearer = await loadAuthenticateBearer();
    const token = await signAccessToken(entraIssuer());
    await Promise.all(
      Array.from({ length: 5 }, () => authenticateBearer(`Bearer ${token}`)),
    );

    expect(discoveryPathsSeen()).toHaveLength(1);
  });
});
