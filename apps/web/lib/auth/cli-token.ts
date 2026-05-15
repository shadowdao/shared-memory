import { SignJWT, jwtVerify, decodeProtectedHeader } from "jose";
import type { JWTPayload } from "jose";
import { env } from "@/lib/env";

/**
 * "CLI tokens" are HMAC-signed JWTs minted on demand from the /connect page
 * after the user logs into the Web UI via Authentik. They're suitable for
 * pasting into an MCP client's Authorization header on machines where the
 * OAuth loopback callback isn't reachable (containers, headless setups).
 *
 * Trust model: we trust whoever holds CLI_TOKEN_SECRET. Verification is a
 * local HMAC check — no JWKS roundtrip. To revoke ALL outstanding CLI
 * tokens, rotate CLI_TOKEN_SECRET.
 *
 * The payload carries the user's real Authentik identity in `iss` + `sub`
 * so the same `users` row resolution path works for both token kinds.
 *
 * Dispatch from the standard Authentik verifier is by the `kid` header:
 * CLI tokens set `kid: "cli-v1"`, Authentik tokens carry whatever key id
 * the JWKS published.
 */

export const CLI_TOKEN_KID = "cli-v1";
export const CLI_TOKEN_ISSUER = "shared-memory:cli";
export const CLI_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

function secret(): Uint8Array {
  return new TextEncoder().encode(env().CLI_TOKEN_SECRET);
}

export interface CliTokenSubject {
  oidcIss: string;
  oidcSub: string;
  email?: string | null;
  name?: string | null;
}

export async function mintCliToken(subject: CliTokenSubject): Promise<string> {
  return await new SignJWT({
    oidc_iss: subject.oidcIss,
    oidc_sub: subject.oidcSub,
    email: subject.email ?? undefined,
    name: subject.name ?? undefined,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT", kid: CLI_TOKEN_KID })
    .setIssuer(CLI_TOKEN_ISSUER)
    .setSubject(subject.oidcSub)
    .setAudience(env().OIDC_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${CLI_TOKEN_TTL_SECONDS}s`)
    .sign(secret());
}

export interface CliClaims extends JWTPayload {
  sub: string;
  iss: string;
  oidc_iss: string;
  oidc_sub: string;
}

export async function verifyCliToken(token: string): Promise<CliClaims> {
  const { payload } = await jwtVerify(token, secret(), {
    issuer: CLI_TOKEN_ISSUER,
    audience: env().OIDC_AUDIENCE,
  });
  if (typeof payload.oidc_iss !== "string" || typeof payload.oidc_sub !== "string") {
    throw new Error("CLI token missing oidc_iss/oidc_sub claims");
  }
  return payload as CliClaims;
}

/** Peek at the `kid` header without verifying. Used to pick a verifier. */
export function tokenKid(token: string): string | undefined {
  try {
    const header = decodeProtectedHeader(token);
    return typeof header.kid === "string" ? header.kid : undefined;
  } catch {
    return undefined;
  }
}
