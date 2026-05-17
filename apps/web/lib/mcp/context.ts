import { db } from "@/lib/db/client";
import { users, groups, userGroups } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import type { AuthenticatedClaims } from "@/lib/auth/jwt";

/**
 * Per-request user context for MCP tool handlers.
 *
 * Resolves (or creates) the internal `users` row from the OIDC claims so
 * tools work with stable UUID foreign keys rather than raw `sub` strings.
 */
export interface UserContext {
  /** Internal users.id UUID. */
  userId: string;
  /** OIDC sub claim (stable identifier from the IdP). */
  sub: string;
  /** OIDC issuer. */
  iss: string;
  /** Optional profile fields if present in the access token. */
  email: string | null;
  name: string | null;
  /**
   * Group *names* the user is a member of. For OIDC bearer tokens these are
   * the live values from the verified token's `groups` claim. For CLI tokens
   * (which carry no groups claim), this is the DB snapshot from the user's
   * last interactive sign-in — necessarily stale, but the only signal we
   * have without going back to the IdP.
   */
  groups: string[];
  /**
   * Project key supplied via the `X-Project-Key` request header. Tools that
   * accept an optional `project` argument use this as a fallback when the
   * caller didn't pass one explicitly. Always validated upstream against
   * the same Zod schema as the tool argument.
   */
  defaultProjectKey?: string;
}

export interface UserContextOverrides {
  /** Project key from the X-Project-Key request header (already validated). */
  defaultProjectKey?: string;
}

export async function userContextFromClaims(
  claims: AuthenticatedClaims,
  overrides: UserContextOverrides = {},
): Promise<UserContext> {
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

  let userId = row[0]?.id;
  if (!userId) {
    // Race against another upsert — fall back to a select.
    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.oidcIss, claims.iss), eq(users.oidcSub, claims.sub)))
      .limit(1);
    if (!existing[0]) throw new Error("user upsert failed and not found on re-read");
    userId = existing[0].id;
  }

  // OIDC bearer tokens carry a `groups` claim (when the IdP is configured to
  // emit it). CLI tokens never do — they go through verifyCliToken which
  // doesn't set claims.groups. In that case fall back to the DB snapshot
  // from the user's last interactive sign-in.
  const groupNames =
    claims.groups ?? (await loadUserGroups(userId));

  return {
    userId,
    sub: claims.sub,
    iss: claims.iss,
    email,
    name,
    groups: groupNames,
    defaultProjectKey: overrides.defaultProjectKey,
  };
}

async function loadUserGroups(userId: string): Promise<string[]> {
  const rows = await db
    .select({ name: groups.name })
    .from(userGroups)
    .innerJoin(groups, eq(userGroups.groupId, groups.id))
    .where(eq(userGroups.userId, userId));
  return rows.map((r) => r.name);
}
