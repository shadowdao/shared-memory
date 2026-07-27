import { NextResponse } from "next/server";
import { env } from "@/lib/env";

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

  return NextResponse.json({
    resource,
    authorization_servers: [env().OIDC_ISSUER],
    scopes_supported: ["openid", "profile", "email", audienceScope],
    bearer_methods_supported: ["header"],
    resource_documentation: `${resource}/`,
  });
}
