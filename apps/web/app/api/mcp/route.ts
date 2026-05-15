import { NextResponse } from "next/server";
import { authenticateBearer, UnauthorizedError } from "@/lib/auth/jwt";
import { userContextFromClaims } from "@/lib/mcp/context";
import { dispatchMcpMessage } from "@/lib/mcp/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * MCP streamable-HTTP endpoint.
 *
 * Auth:  Bearer token (Authentik-issued JWT). Unauthed requests get 401 with
 *        a WWW-Authenticate header pointing at our RFC 9728 resource metadata
 *        so MCP clients can discover the authorization server.
 *
 * Body:  JSON-RPC 2.0 message (request or notification).
 *
 * Reply: For requests, the JSON-RPC response in the body with
 *        `Content-Type: application/json`.
 *        For notifications, HTTP 202 with empty body.
 */

export async function POST(req: Request) {
  // ---- auth ----
  let claims;
  try {
    claims = await authenticateBearer(req.headers.get("authorization"));
  } catch (e) {
    if (e instanceof UnauthorizedError) {
      return new NextResponse(JSON.stringify({ error: e.reason }), {
        status: 401,
        headers: {
          "WWW-Authenticate": e.wwwAuthenticate,
          "Content-Type": "application/json",
        },
      });
    }
    throw e;
  }

  // ---- parse body ----
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } },
      { status: 400 },
    );
  }

  // ---- resolve user, dispatch ----
  const ctx = await userContextFromClaims(claims);

  // MCP supports batched requests (array) and single. Handle both.
  if (Array.isArray(body)) {
    const responses = await Promise.all(body.map((m) => dispatchMcpMessage(m, ctx)));
    const filtered = responses.filter((r) => r !== null);
    if (filtered.length === 0) {
      return new NextResponse(null, { status: 202 });
    }
    return NextResponse.json(filtered, { status: 200 });
  }

  const response = await dispatchMcpMessage(body, ctx);
  if (response === null) {
    // Notification — no body expected.
    return new NextResponse(null, { status: 202 });
  }
  return NextResponse.json(response, { status: 200 });
}

// MCP clients sometimes probe with GET (for SSE). We don't support
// server-initiated events in Phase 1 — return 405 with a discoverable header.
export function GET() {
  return new NextResponse(null, {
    status: 405,
    headers: { Allow: "POST" },
  });
}
