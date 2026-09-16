import { env } from "@/lib/env";
import { mcpIssuer } from "@/lib/auth/jwt";

/**
 * The protected-resource metadata document, RFC 9728 §2.
 *
 * Shared by both metadata routes — the root `/.well-known/oauth-protected-
 * resource` and the path-suffixed `/.well-known/oauth-protected-resource/
 * <resource path>` form of §3.1 — because the two documents differ ONLY in
 * the `resource` identifier they describe. Anything else drifting between
 * them is a bug: a client that discovers us through the suffixed URL would
 * be told to request a different scope set than one that follows the
 * `WWW-Authenticate: resource_metadata=...` header, and whichever of the two
 * lost the audience scope would hand back tokens with no `aud` claim.
 */
export interface ResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  bearer_methods_supported: string[];
  resource_documentation: string;
}

/**
 * The public origin, with any trailing slash stripped.
 *
 * `resource` values are compared as exact strings by clients (RFC 9728 §3.3),
 * so `https://host/` and `https://host` are not interchangeable — PUBLIC_URL
 * is written both ways in the wild and only the stripped form is emitted.
 */
export function publicOrigin(): string {
  return env().PUBLIC_URL.replace(/\/$/, "");
}

/**
 * Build the metadata document for `resource`.
 *
 * The caller supplies the resource identifier because it depends on which
 * URL the document was fetched from; everything else is deployment config.
 */
export function buildResourceMetadata(resource: string): ResourceMetadata {
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

  return {
    resource,
    // The MCP application's issuer, which is not necessarily the Web UI's —
    // see mcpIssuer(). Advertising the wrong one sends clients to a discovery
    // document whose tokens this endpoint will then reject on `iss`.
    authorization_servers: [mcpIssuer()],  // as configured, slash and all
    scopes_supported: scopes,
    bearer_methods_supported: ["header"],
    // Documentation lives at the site root regardless of which resource this
    // document describes, so it is always derived from the public origin and
    // not from `resource`.
    resource_documentation: `${publicOrigin()}/`,
  };
}
