import { NextResponse } from "next/server";
import { buildResourceMetadata, publicOrigin } from "@/lib/auth/resource-metadata";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * RFC 9728 — OAuth 2.0 Protected Resource Metadata.
 *
 * MCP clients discover the authorization server (Authentik) via this
 * endpoint after receiving a 401 with `WWW-Authenticate: resource_metadata=...`.
 *
 * This is the root form of the document, describing the deployment origin as
 * the protected resource. Clients that derive the metadata URL from the MCP
 * endpoint URL instead of following the header land on the path-suffixed form
 * (§3.1) served by the sibling `[...path]` route.
 */
export function GET() {
  return NextResponse.json(buildResourceMetadata(publicOrigin()));
}
