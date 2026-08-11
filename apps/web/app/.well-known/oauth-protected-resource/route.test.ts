import { afterEach, describe, expect, test, vi } from "vitest";

/**
 * The resource metadata document is the ONLY way an MCP client learns which
 * scopes to request. Authentik evaluates a scope mapping only when the client
 * asks for that scope by name — so a scope missing from this document is a
 * scope the client will never request, no matter how the IdP is configured.
 *
 * That is exactly how `offline_access` came to be missing: without it the IdP
 * issues an access token and no refresh token, so the client cannot renew
 * silently and the user is forced to re-authenticate every time the access
 * token expires.
 */

async function fetchMetadata(): Promise<{ scopes_supported: string[] }> {
  vi.resetModules();
  const { GET } = await import("@/app/.well-known/oauth-protected-resource/route");
  return (await GET().json()) as { scopes_supported: string[] };
}

afterEach(() => {
  delete process.env.OIDC_OFFLINE_ACCESS;
  delete process.env.OIDC_AUDIENCE_SCOPE;
});

describe("oauth-protected-resource metadata", () => {
  test("omits offline_access by default, so deployments without the IdP mapping are unaffected", async () => {
    const body = await fetchMetadata();

    expect(body.scopes_supported).not.toContain("offline_access");
  });

  test("advertises offline_access when the deployment opts in", async () => {
    process.env.OIDC_OFFLINE_ACCESS = "true";

    const body = await fetchMetadata();

    expect(body.scopes_supported).toContain("offline_access");
  });

  test("still advertises the audience scope when offline_access is enabled", async () => {
    // Regression guard: the audience scope is what makes `aud` appear on the
    // token at all. Dropping it would break authentication outright.
    process.env.OIDC_OFFLINE_ACCESS = "true";

    const body = await fetchMetadata();

    expect(body.scopes_supported).toContain("aud-test-audience");
    expect(body.scopes_supported).toEqual(
      expect.arrayContaining(["openid", "profile", "email"]),
    );
  });

  test("honours an explicit audience scope name alongside offline_access", async () => {
    process.env.OIDC_OFFLINE_ACCESS = "true";
    process.env.OIDC_AUDIENCE_SCOPE = "custom-aud-scope";

    const body = await fetchMetadata();

    expect(body.scopes_supported).toContain("custom-aud-scope");
    expect(body.scopes_supported).toContain("offline_access");
  });
});
