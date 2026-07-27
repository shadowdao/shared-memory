import { createRemoteJWKSet, jwtVerify, errors as joseErrors } from "jose";
import type { JWTPayload } from "jose";
import { env } from "@/lib/env";
import { CLI_TOKEN_KID, tokenKid, verifyCliToken } from "./cli-token";

/**
 * Authenticates a bearer token presented to the MCP endpoint. Two token
 * kinds are accepted, dispatched by the JWT `kid` header:
 *
 *   - Authentik-issued OIDC access tokens (any kid) — verified against
 *     Authentik's JWKS over the network.
 *   - CLI tokens minted at /connect (kid="cli-v1") — verified locally
 *     with the HMAC CLI_TOKEN_SECRET.
 *
 * Both resolve to the same `AuthenticatedClaims` shape so downstream code
 * (`userContextFromClaims`) doesn't care which path produced them.
 *
 * This is distinct from the NextAuth session cookie path used by the Web UI.
 */

type GlobalWithJwks = typeof globalThis & {
  __sharedMemoryJwks?: ReturnType<typeof createRemoteJWKSet>;
};
const g = globalThis as GlobalWithJwks;

/**
 * Issuer of MCP access tokens. The MCP endpoint is a separate application in
 * the IdP from the Web UI, and Authentik stamps each token with its own
 * application slug, so this is NOT interchangeable with OIDC_ISSUER.
 */
export function mcpIssuer(): string {
  return (env().OIDC_ISSUER_MCP ?? env().OIDC_ISSUER).replace(/\/$/, "");
}

function jwks() {
  if (g.__sharedMemoryJwks) return g.__sharedMemoryJwks;
  // Authentik discovery is at `${issuer}/.well-known/openid-configuration`;
  // the JWKS URI is normally `${issuer}/jwks/` or `${issuer}/.well-known/jwks.json`.
  // Authentik canonically serves `${issuer}/jwks/`.
  const url = new URL(`${mcpIssuer()}/jwks/`);
  g.__sharedMemoryJwks = createRemoteJWKSet(url, {
    cacheMaxAge: 10 * 60 * 1000, // 10 min
    cooldownDuration: 30 * 1000,
  });
  return g.__sharedMemoryJwks;
}

export interface AuthenticatedClaims extends JWTPayload {
  sub: string;
  iss: string;
  /**
   * Group names from the OIDC `groups` claim. Authentik / Keycloak / properly-
   * configured EntraID emit `string[]` here. We coerce non-array / non-string
   * entries away and present an empty array if the claim is absent. For CLI
   * (HMAC) tokens this is always undefined — the consumer (userContextFromClaims)
   * falls back to the DB snapshot from the user's last interactive sign-in.
   */
  groups?: string[];
}

export class UnauthorizedError extends Error {
  constructor(
    public readonly reason: string,
    public readonly wwwAuthenticate: string,
  ) {
    super(reason);
    this.name = "UnauthorizedError";
  }
}

/**
 * Pull `groups` off a verified OIDC payload as a clean `string[]`. Non-
 * string entries are dropped silently. Returns undefined when the claim
 * is absent so callers can distinguish "no claim emitted" from "user is
 * in zero groups" (`[]`).
 */
function extractGroupsClaim(payload: JWTPayload): string[] | undefined {
  const raw = (payload as { groups?: unknown }).groups;
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v === "string" && v.trim().length > 0) out.push(v.trim());
  }
  return out;
}

function buildWwwAuthenticate(error?: string, description?: string): string {
  const parts: string[] = [`Bearer realm="OAuth"`];
  // RFC 9728 — point clients at our protected-resource metadata so they can
  // discover the authorization server.
  parts.push(`resource_metadata="${env().PUBLIC_URL.replace(/\/$/, "")}/.well-known/oauth-protected-resource"`);
  if (error) parts.push(`error="${error}"`);
  if (description) parts.push(`error_description="${description.replace(/"/g, "'")}"`);
  return parts.join(", ");
}

export async function authenticateBearer(authHeader: string | null): Promise<AuthenticatedClaims> {
  if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
    throw new UnauthorizedError("missing bearer token", buildWwwAuthenticate());
  }

  const token = authHeader.slice("bearer ".length).trim();
  if (!token) {
    throw new UnauthorizedError("empty bearer token", buildWwwAuthenticate("invalid_token"));
  }

  // Dispatch by kid: CLI tokens are verified locally, everything else goes
  // through Authentik JWKS. We never attempt JWKS verification for CLI
  // tokens (or vice versa) so a kid mismatch fails fast.
  const isCliToken = tokenKid(token) === CLI_TOKEN_KID;

  try {
    if (isCliToken) {
      const claims = await verifyCliToken(token);
      // CLI tokens carry the user's real Authentik identity in oidc_iss /
      // oidc_sub. Surface those on the standard claims shape so user
      // context resolution is identical to the Authentik path. CLI tokens
      // never carry a groups claim — leave `groups` undefined; the user-
      // context resolver falls back to the DB snapshot.
      return {
        ...claims,
        iss: claims.oidc_iss,
        sub: claims.oidc_sub,
      } as AuthenticatedClaims;
    }

    const { payload } = await jwtVerify(token, jwks(), {
      issuer: mcpIssuer(),
      audience: env().OIDC_AUDIENCE,
    });
    if (!payload.sub) {
      throw new UnauthorizedError(
        "token missing sub claim",
        buildWwwAuthenticate("invalid_token", "missing sub"),
      );
    }
    // Normalize the issuer for identity purposes.
    //
    // The token was just verified against mcpIssuer() — that check is done.
    // But identity is keyed on (oidc_iss, oidc_sub), and the Web UI signs
    // people in through a DIFFERENT application whose tokens carry
    // OIDC_ISSUER. Authentik's `sub` is stable across providers (it is
    // `user.uid`, a user-level value), so the only thing that differs is the
    // issuer.
    //
    // Leave it un-normalized and userContextFromClaims — which UPSERTS rather
    // than failing — quietly creates a SECOND user row for the same human:
    // MCP writes would land in an account with none of their memories, and
    // nothing would look broken. Pin identity to the canonical issuer.
    return {
      ...payload,
      iss: env().OIDC_ISSUER,
      groups: extractGroupsClaim(payload),
    } as AuthenticatedClaims;
  } catch (err) {
    if (err instanceof UnauthorizedError) throw err;
    const desc =
      err instanceof joseErrors.JWTExpired
        ? "token expired"
        : err instanceof joseErrors.JWTInvalid
        ? "token invalid"
        : err instanceof joseErrors.JWTClaimValidationFailed
        ? `claim invalid: ${err.claim}`
        : "verification failed";
    throw new UnauthorizedError(desc, buildWwwAuthenticate("invalid_token", desc));
  }
}
