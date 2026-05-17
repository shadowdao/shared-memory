import { and, eq, notInArray, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { groups, userGroups } from "@/lib/db/schema";

/**
 * Sync a user's group memberships from the OIDC `groups` claim on sign-in.
 *
 * Claim shape: `string[]`. Authentik emits group *names* directly here;
 * Keycloak and Okta likewise (with the right mappers configured). EntraID,
 * when correctly configured per README, emits names too — but the default
 * "groups" optional-claim variant emits object-id GUIDs instead, and if the
 * user is in too many groups EntraID switches to a "groups overage"
 * indicator (no group list at all). We take the conservative path:
 *
 *   - whatever strings appear in the claim are treated as names verbatim
 *     and stored as-is. If your IdP emits GUIDs, the UI will show GUIDs;
 *     fix it at the IdP layer (we don't attempt resolution).
 *   - if the claim is missing/empty, the user is treated as having zero
 *     groups and all existing memberships are deleted.
 *   - groups overage (where EntraID emits `_claim_names.groups` instead of
 *     `groups`) is not handled in v1 — the user appears as having no
 *     groups. Documented limit; revisit if it bites someone.
 *
 * The whole operation runs in a single transaction so the membership
 * snapshot is atomic (no window where a user partially has new memberships
 * and still has stale ones).
 */
export async function syncUserGroupsFromClaim(
  userId: string,
  oidcIss: string,
  rawClaim: unknown,
): Promise<void> {
  const names = normalizeGroupsClaim(rawClaim);

  await db.transaction(async (tx) => {
    if (names.length === 0) {
      // Claim missing/empty → user has zero groups now.
      await tx.delete(userGroups).where(eq(userGroups.userId, userId));
      return;
    }

    // Upsert each group row keyed by (oidc_iss, name) and collect ids.
    // We use a single multi-row insert for the round-trip win; the DB
    // resolves duplicates via the unique index.
    const inserted = await tx
      .insert(groups)
      .values(names.map((name) => ({ oidcIss, name })))
      .onConflictDoUpdate({
        target: [groups.oidcIss, groups.name],
        // Touch updated_at so we have a "last seen" signal at the group
        // level too; otherwise this would be a do-nothing on conflict.
        set: { updatedAt: new Date() },
      })
      .returning({ id: groups.id, name: groups.name });

    const groupIds = inserted.map((g) => g.id);

    // Insert (or refresh synced_at on) every current membership.
    await tx
      .insert(userGroups)
      .values(groupIds.map((groupId) => ({ userId, groupId })))
      .onConflictDoUpdate({
        target: [userGroups.userId, userGroups.groupId],
        set: { syncedAt: sql`now()` },
      });

    // Delete memberships that no longer appear in the claim. We could
    // alternatively rely on `synced_at < now()` to find stale rows, but
    // an explicit NOT IN is cheaper and clearer.
    await tx
      .delete(userGroups)
      .where(
        and(eq(userGroups.userId, userId), notInArray(userGroups.groupId, groupIds)),
      );
  });
}

/**
 * Coerce whatever the IdP put in `profile.groups` into a clean string[]
 * of distinct, trimmed, non-empty names. Anything non-string is dropped.
 */
function normalizeGroupsClaim(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out = new Set<string>();
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const t = v.trim();
    if (t.length === 0) continue;
    out.add(t);
  }
  return Array.from(out);
}

