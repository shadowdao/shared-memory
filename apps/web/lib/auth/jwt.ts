import { createRemoteJWKSet, jwtVerify, errors as joseErrors } from "jose";
import type { JWTPayload } from "jose";
import { env } from "@/lib/env";

/**
 * Authenticates a bearer token issued by Authentik against the configured
 * OIDC issuer. Verifies signature (via JWKS), issuer, audience, and expiry.
 *
 * Used by the MCP endpoint to authenticate incoming Claude Code requests.
 * Distinct from the NextAuth session cookie path used by the Web UI.
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

  try {
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
