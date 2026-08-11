import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { mcpIssuer } from "@/lib/auth/jwt";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * RFC 9728 — OAuth 2.0 Protected Resource Metadata.
 *
 * MCP clients discover the authorization server (Authentik) via this
 * endpoint after receiving a 401 with `WWW-Authenticate: resource_metadata=...`.
 */
export function GET() {
  const resource = env().PUBLIC_URL.replace(/\/$/, "");

  // The audience scope MUST be advertised. Authentik only evaluates a scope
  // mapping when the client requests that scope by name, and the client only
  // learns scope names from this document. Omit it and every access token
  // arrives without `aud`, which jwt.ts rejects as "claim invalid: aud".
  const audienceScope =
    env().OIDC_AUDIENCE_SCOPE ?? `aud-${env().OIDC_AUDIENCE}`;

  // Same mechanism as the audience scope, different consequence: a client
  // only requests `offline_access` if it sees the name here, and without
  // that request the IdP returns no refresh token — so the client cannot
  // renew and the user gets kicked back to an interactive login whenever
  // the access token expires.
  //
  // Opt-in, because the IdP needs a matching scope mapping; advertising one
  // it doesn't offer can fail the whole authorization request.
  const scopes = ["openid", "profile", "email", audienceScope];
  if (env().OIDC_OFFLINE_ACCESS) scopes.push("offline_access");

  return NextResponse.json({
    resource,
    // The MCP application's issuer, which is not necessarily the Web UI's —
    // see mcpIssuer(). Advertising the wrong one sends clients to a discovery
    // document whose tokens this endpoint will then reject on `iss`.
    authorization_servers: [mcpIssuer()],  // as configured, slash and all
    scopes_supported: scopes,
    bearer_methods_supported: ["header"],
    resource_documentation: `${resource}/`,
  });
}
