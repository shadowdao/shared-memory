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

function jwks() {
  if (g.__sharedMemoryJwks) return g.__sharedMemoryJwks;
  // Authentik discovery is at `${issuer}/.well-known/openid-configuration`;
  // the JWKS URI is normally `${issuer}/jwks/` or `${issuer}/.well-known/jwks.json`.
  // Authentik canonically serves `${issuer}/jwks/`.
  const issuer = env().OIDC_ISSUER.replace(/\/$/, "");
  const url = new URL(`${issuer}/jwks/`);
  g.__sharedMemoryJwks = createRemoteJWKSet(url, {
    cacheMaxAge: 10 * 60 * 1000, // 10 min
    cooldownDuration: 30 * 1000,
  });
  return g.__sharedMemoryJwks;
}

export interface AuthenticatedClaims extends JWTPayload {
  sub: string;
  iss: string;
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
      // context resolution is identical to the Authentik path.
      return {
        ...claims,
        iss: claims.oidc_iss,
        sub: claims.oidc_sub,
      } as AuthenticatedClaims;
    }

    const { payload } = await jwtVerify(token, jwks(), {
      issuer: env().OIDC_ISSUER,
      audience: env().OIDC_AUDIENCE,
    });
    if (!payload.sub) {
      throw new UnauthorizedError(
        "token missing sub claim",
        buildWwwAuthenticate("invalid_token", "missing sub"),
      );
    }
    return payload as AuthenticatedClaims;
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
