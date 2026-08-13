import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { users } from "@/lib/db/schema";

/**
 * Resolving OIDC claims to the internal `users.id`.
 *
 * Both surfaces come through here — the Web UI (`auth.ts`) and the MCP
 * endpoint (`lib/mcp/context.ts`) — and that is the point. They each used to
 * carry their own copy of this upsert, which is how the two drifted into
 * disagreeing about who a user is.
 *
 * ## Why `oid` exists here
 *
 * Authentik's `sub` is `user.uid`, identical across every provider, so
 * (iss, sub) identifies a person. EntraID's `sub` is PAIRWISE: Microsoft
 * derives it from the token recipient, so the Web UI app registration and the
 * MCP app registration emit different `sub` values for the same human. Keyed
 * on `sub`, that person gets two rows — they sign into the Web UI, connect
 * Claude Code, and find an empty account. Both paths upsert, so nothing
 * errors; the split is completely silent.
 *
 * `oid` is the directory object id, which Microsoft documents as constant for
 * a user across every application in a tenant. When it's present it wins.
 * When it's absent (Authentik, Keycloak, Okta) behaviour is exactly as before.
 */

/** Extract a usable EntraID `oid` claim, or null on IdPs that don't emit one. */
export function oidClaim(claims: unknown): string | null {
  const raw = (claims as { oid?: unknown } | null | undefined)?.oid;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export interface IdentityInput {
  iss: string;
  sub: string;
  /** EntraID object id, or null. */
  oid: string | null;
  email: string | null;
  name: string | null;
  picture: string | null;
}

/** Postgres unique-violation. */
function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "23505";
}

/**
 * Resolve (creating if needed) the `users` row for a set of verified claims.
 *
 * Resolution order when `oid` is present:
 *
 *   1. a row already keyed on this `oid` — the steady state
 *   2. a pre-`oid` row for the same (iss, sub), which gets its `oid`
 *      backfilled in place. This is how a deployment that ran before the
 *      0005 migration keeps its accounts instead of stranding them.
 *   3. insert
 *
 * Without `oid` this collapses to the original (iss, sub) upsert.
 */
export async function resolveUserId(input: IdentityInput): Promise<string> {
  const { iss, sub, oid, email, name, picture } = input;
  const profile = { email, name, picture, lastSeenAt: new Date() };

  if (oid) {
    // 1. Steady state.
    //
    // Deliberately does NOT touch `oidc_sub`. The stored value is whichever
    // app registration this person first arrived through; rewriting it on
    // every request would flip it back and forth between the Web and MCP
    // values and could collide with the (iss, sub) unique index.
    const byOid = await db
      .update(users)
      .set(profile)
      .where(and(eq(users.oidcIss, iss), eq(users.oidcOid, oid)))
      .returning({ id: users.id });
    if (byOid[0]) return byOid[0].id;

    // 2. Adopt a row created before `oid` was recorded.
    const adopted = await db
      .update(users)
      .set({ ...profile, oidcOid: oid })
      .where(
        and(eq(users.oidcIss, iss), eq(users.oidcSub, sub), isNull(users.oidcOid)),
      )
      .returning({ id: users.id });
    if (adopted[0]) return adopted[0].id;
  }

  // 3. Insert. The conflict target stays (iss, sub) because that is the index
  //    every row has; a concurrent writer racing us on `oid` instead is caught
  //    below.
  try {
    const inserted = await db
      .insert(users)
      .values({ oidcIss: iss, oidcSub: sub, oidcOid: oid, email, name, picture })
      .onConflictDoUpdate({
        target: [users.oidcIss, users.oidcSub],
        set: profile,
      })
      .returning({ id: users.id });
    if (inserted[0]) return inserted[0].id;
  } catch (err) {
    // Two requests for the same person arriving together through DIFFERENT
    // app registrations: same `oid`, different `sub`, so the (iss, sub)
    // conflict target doesn't fire and the partial (iss, oid) index rejects
    // the loser. Fall through and read the winner's row.
    if (!isUniqueViolation(err)) throw err;
  }

  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(
      oid
        ? and(eq(users.oidcIss, iss), eq(users.oidcOid, oid))
        : and(eq(users.oidcIss, iss), eq(users.oidcSub, sub)),
    )
    .limit(1);
  if (!existing[0]) throw new Error("user upsert failed and not found on re-read");
  return existing[0].id;
}
