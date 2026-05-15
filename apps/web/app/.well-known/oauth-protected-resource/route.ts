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
  return NextResponse.json({
    resource,
    authorization_servers: [env().OIDC_ISSUER],
    scopes_supported: ["openid", "profile", "email"],
    bearer_methods_supported: ["header"],
    resource_documentation: `${resource}/`,
  });
}
