import { randomUUID } from "node:crypto";
import { SignJWT, jwtVerify, decodeProtectedHeader } from "jose";
import type { JWTPayload } from "jose";
import { and, eq, isNull } from "drizzle-orm";
import { env } from "@/lib/env";
import { db } from "@/lib/db/client";
import { cliTokens } from "@/lib/db/schema";

/**
 * CLI tokens — HMAC-signed JWTs minted from /settings/tokens (or the
 * legacy /connect page) after the user logs into the Web UI via OIDC.
 *
 * Suitable for pasting into an MCP client's `Authorization` header on
 * machines where the OAuth loopback callback isn't reachable.
 *
 * Trust model: we trust whoever holds CLI_TOKEN_SECRET. Verification is a
 * local HMAC check — no JWKS round-trip — plus an opt-in revocation
 * lookup in the `cli_tokens` table.
 *
 *   - Tokens minted by mintCliToken always carry a `jti` claim and have a
 *     matching row in cli_tokens.
 *   - Tokens minted by an older version of this server have no `jti`. We
 *     accept them on signature validity alone until they expire naturally
 *     (max 30 days post-deploy). Their only revocation knob is rotating
 *     CLI_TOKEN_SECRET.
 *
 * To revoke a tracked token immediately, set cli_tokens.revoked_at.
 */

export const CLI_TOKEN_KID = "cli-v1";
export const CLI_TOKEN_ISSUER = "shared-memory:cli";
export const CLI_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

function secret(): Uint8Array {
  return new TextEncoder().encode(env().CLI_TOKEN_SECRET);
}

export interface CliTokenSubject {
  userId: string;
  oidcIss: string;
  oidcSub: string;
  email?: string | null;
  name?: string | null;
}

export interface MintCliTokenOptions {
  /** Human-readable label shown in the Settings UI. */
  tokenName: string;
}

export interface MintCliTokenResult {
  token: string;
  jti: string;
  expiresAt: Date;
}

export async function mintCliToken(
  subject: CliTokenSubject,
  options: MintCliTokenOptions,
): Promise<MintCliTokenResult> {
  const jti = randomUUID();
  const expiresAt = new Date(Date.now() + CLI_TOKEN_TTL_SECONDS * 1000);

  // Record the issued token first so a crash mid-mint can't leak a usable
  // token that isn't in our registry.
  await db.insert(cliTokens).values({
    userId: subject.userId,
    jti,
    name: options.tokenName,
    expiresAt,
  });

  const token = await new SignJWT({
    oidc_iss: subject.oidcIss,
    oidc_sub: subject.oidcSub,
    email: subject.email ?? undefined,
    name: subject.name ?? undefined,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT", kid: CLI_TOKEN_KID })
    .setIssuer(CLI_TOKEN_ISSUER)
    .setSubject(subject.oidcSub)
    .setAudience(env().OIDC_AUDIENCE)
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime(`${CLI_TOKEN_TTL_SECONDS}s`)
    .sign(secret());

  return { token, jti, expiresAt };
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

  // If the token carries a jti, enforce the revocation registry. Tokens
  // minted before the registry existed have no jti — accept those on
  // signature alone until natural expiration.
  if (typeof payload.jti === "string") {
    const rows = await db
      .select({ id: cliTokens.id, revokedAt: cliTokens.revokedAt })
      .from(cliTokens)
      .where(eq(cliTokens.jti, payload.jti))
      .limit(1);
    const row = rows[0];
    if (!row) {
      throw new Error("CLI token not in registry — likely minted by another deployment");
    }
    if (row.revokedAt) {
      throw new Error("CLI token revoked");
    }
    // Touch last_used_at — best-effort, don't fail the request if this errors.
    void db
      .update(cliTokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(cliTokens.id, row.id))
      .catch(() => {});
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

/** Revoke a token by id (owned by the given user). */
export async function revokeCliToken(userId: string, tokenId: string): Promise<boolean> {
  const result = await db
    .update(cliTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(eq(cliTokens.id, tokenId), eq(cliTokens.userId, userId), isNull(cliTokens.revokedAt)),
    )
    .returning({ id: cliTokens.id });
  return result.length > 0;
}
