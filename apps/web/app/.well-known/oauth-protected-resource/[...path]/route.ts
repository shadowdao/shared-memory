import { NextResponse } from "next/server";
import { buildResourceMetadata, publicOrigin } from "@/lib/auth/resource-metadata";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Resource paths this deployment will publish metadata for.
 *
 * An allowlist rather than a wildcard, for two reasons. RFC 9728 §3.1 maps a
 * metadata URL to one specific protected resource, so answering for arbitrary
 * paths would advertise resources this app does not serve — a client could
 * "discover" `https://host/anything` as an OAuth-protected resource and be
 * told, wrongly, that tokens for it are obtainable from our IdP. And every
 * path that answers is surface: a wildcard turns this into an open reflector
 * that echoes attacker-chosen path segments back inside a JSON document.
 *
 * `api/mcp` is the only MCP endpoint here (app/api/mcp/route.ts). Add an
 * entry when a second one ships — not before.
 */
const METADATA_RESOURCE_PATHS: ReadonlySet<string> = new Set(["api/mcp"]);

/**
 * RFC 9728 §3.1 — path-suffixed protected resource metadata.
 *
 * For a resource identified by `https://host/api/mcp`, the spec puts its
 * metadata at `https://host/.well-known/oauth-protected-resource/api/mcp`:
 * the resource's path is appended to the well-known path. Clients that derive
 * the metadata URL from the MCP endpoint URL — rather than reading
 * `resource_metadata` off our 401's `WWW-Authenticate` header — probe that URL
 * first, and before this route existed they got Next.js's 404 HTML page, which
 * fails discovery with a JSON parse error rather than anything diagnosable.
 *
 * The document is identical to the root one except for `resource`, which must
 * name the suffixed identifier: §3.3 requires the client to check that the
 * returned `resource` equals the identifier it asked about, so echoing the
 * bare origin here would make a strict client reject the document outright.
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ path: string[] }> },
): Promise<NextResponse> {
  const { path } = await ctx.params;
  // Next splits the matched suffix on literal `/` and only then decodes each
  // piece, so a segment can be empty (`api//mcp` -> ["api","","mcp"]) and a
  // single segment can itself contain a decoded slash (`api%2Fmcp` -> one
  // element, "api/mcp"). Join and compare on the same normalized form the
  // allowlist is written in, and let anything else fail closed.
  const resourcePath = path.join("/");

  if (!METADATA_RESOURCE_PATHS.has(resourcePath)) {
    // JSON, not the HTML 404 page, so a client that probes a wrong path gets
    // a parseable answer instead of the failure mode this route exists to fix.
    return NextResponse.json(
      { error: "not_found", error_description: "no such protected resource" },
      { status: 404 },
    );
  }

  return NextResponse.json(
    buildResourceMetadata(`${publicOrigin()}/${resourcePath}`),
  );
}
