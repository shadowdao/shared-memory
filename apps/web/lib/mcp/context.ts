import { db } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import type { AuthenticatedClaims } from "@/lib/auth/jwt";

/**
 * Per-request user context for MCP tool handlers.
 *
 * Resolves (or creates) the internal `users` row from the Authentik OIDC
 * claims so tools work with stable UUID foreign keys rather than raw `sub`
 * strings.
 */
export interface UserContext {
  /** Internal users.id UUID. */
  userId: string;
  /** OIDC sub claim (stable identifier from Authentik). */
  sub: string;
  /** OIDC issuer. */
  iss: string;
  /** Optional profile fields if present in the access token. */
  email: string | null;
  name: string | null;
}

export async function userContextFromClaims(claims: AuthenticatedClaims): Promise<UserContext> {
  const email = (claims.email as string | undefined) ?? null;
  const name = (claims.name as string | undefined) ?? null;
  const picture = (claims.picture as string | undefined) ?? null;

  const row = await db
    .insert(users)
    .values({
      oidcSub: claims.sub,
      oidcIss: claims.iss,
      email,
      name,
      picture,
    })
    .onConflictDoUpdate({
      target: [users.oidcIss, users.oidcSub],
      set: {
        email,
        name,
        picture,
        lastSeenAt: new Date(),
      },
    })
    .returning({ id: users.id });

  const userId = row[0]?.id;
  if (!userId) {
    // Race against another upsert — fall back to a select.
    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.oidcIss, claims.iss), eq(users.oidcSub, claims.sub)))
      .limit(1);
    if (!existing[0]) throw new Error("user upsert failed and not found on re-read");
    return { userId: existing[0].id, sub: claims.sub, iss: claims.iss, email, name };
  }

  return { userId, sub: claims.sub, iss: claims.iss, email, name };
}
