import { afterEach, describe, expect, test, vi } from "vitest";

/**
 * RFC 9728 §3.1 puts the metadata for `https://host/api/mcp` at
 * `https://host/.well-known/oauth-protected-resource/api/mcp`. MCP clients
 * that derive that URL from the endpoint URL — instead of following the
 * `resource_metadata` parameter on our 401 — used to receive the Next.js 404
 * HTML page here, so discovery died on a JSON parse error.
 *
 * Two things therefore have to hold, and both are easy to break silently:
 * the document must name the SUFFIXED resource (§3.3 has the client reject a
 * document whose `resource` isn't the identifier it asked about), and it must
 * stay byte-for-byte in step with the root document's scope list, because a
 * scope missing from whichever document a given client reads is a scope that
 * client will never request.
 */

type Metadata = { resource: string; scopes_supported: string[] };

async function fetchSuffixed(
  segments: string[],
): Promise<{ status: number; body: Metadata }> {
  vi.resetModules();
  const { GET } = await import(
    "@/app/.well-known/oauth-protected-resource/[...path]/route"
  );
  const res = await GET(new Request("http://localhost/ignored"), {
    params: Promise.resolve({ path: segments }),
  });
  return { status: res.status, body: (await res.json()) as Metadata };
}

async function fetchRoot(): Promise<Metadata> {
  vi.resetModules();
  const { GET } = await import("@/app/.well-known/oauth-protected-resource/route");
  return (await GET().json()) as Metadata;
}

afterEach(() => {
  delete process.env.OIDC_OFFLINE_ACCESS;
  delete process.env.OIDC_AUDIENCE_SCOPE;
});

describe("path-suffixed oauth-protected-resource metadata", () => {
  test("serves the MCP endpoint's document with the suffixed resource identifier", async () => {
    const { status, body } = await fetchSuffixed(["api", "mcp"]);

    expect(status).toBe(200);
    // §3.3: a strict client compares this against the identifier it asked
    // about, so the bare origin would get the whole document rejected.
    expect(body.resource).toBe("http://localhost:3000/api/mcp");
  });

  test("404s for a path this app does not serve, rather than advertising it", async () => {
    // The allowlist exists so we never claim that arbitrary paths are
    // OAuth-protected resources of this deployment.
    const { status } = await fetchSuffixed(["api", "not-mcp"]);

    expect(status).toBe(404);
  });

  test("advertises exactly the scopes the root document does", async () => {
    // Regression guard against the two documents drifting apart: the audience
    // scope is what makes `aud` appear on the token at all, and a client that
    // discovered us through the suffixed URL would never request a scope that
    // only the root document lists.
    process.env.OIDC_OFFLINE_ACCESS = "true";

    const root = await fetchRoot();
    const { body: suffixed } = await fetchSuffixed(["api", "mcp"]);

    expect(suffixed.scopes_supported).toEqual(root.scopes_supported);
    expect(suffixed.scopes_supported).toContain("aud-test-audience");
    expect(suffixed.scopes_supported).toContain("offline_access");
  });

  test("honours an explicit audience scope name, like the root document", async () => {
    process.env.OIDC_AUDIENCE_SCOPE = "custom-aud-scope";

    const root = await fetchRoot();
    const { body: suffixed } = await fetchSuffixed(["api", "mcp"]);

    expect(suffixed.scopes_supported).toContain("custom-aud-scope");
    expect(suffixed.scopes_supported).toEqual(root.scopes_supported);
  });
});
