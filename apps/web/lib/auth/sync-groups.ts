import { and, eq, notInArray, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { groups, userGroups } from "@/lib/db/schema";

/**
 * Raised when the IdP signals that it holds group memberships it declined to
 * enumerate (EntraID's "groups overage"). Callers must abort — see
 * `detectGroupsOverage` for why this cannot be treated as "no groups".
 */
export class GroupsOverageError extends Error {
  constructor() {
    super(
      "OIDC groups overage: the identity provider signalled group membership " +
        "it did not enumerate, so the user's groups cannot be determined. On " +
        "EntraID, set the app registration's `groupMembershipClaims` to " +
        '"ApplicationGroup" (portal: "Groups assigned to the application") and ' +
        "assign the groups you share projects with. See docs/oidc-entra-id.md " +
        "§10b.",
    );
    this.name = "GroupsOverageError";
  }
}

/**
 * Does this token say "there are groups, but I'm not listing them"?
 *
 * EntraID stops emitting `groups` past 200 entries in a JWT (150 in SAML, 5 in
 * implicit flow) and substitutes a pointer:
 *
 *     "_claim_names":   { "groups": "src1" },
 *     "_claim_sources": { "src1": { "endpoint": "https://graph.windows.net/…" } }
 *
 * or, for implicit flow, `"hasgroups": true`.
 *
 * This is NOT a truncated list — it is no list at all, and it is materially
 * different from "this user belongs to zero groups". Conflating the two is
 * what made this dangerous: the absent-claim branch below deletes every one of
 * the user's memberships, so a user crossing the 200-group line would silently
 * lose access to every shared project on both surfaces, with no error raised
 * anywhere.
 *
 * We refuse instead. Group state gates `readableProjectIds` / `canWriteProject`,
 * and granting or revoking access on state we know we don't have is guesswork
 * either way. Failing loudly destroys nothing and names its own fix.
 */
export function detectGroupsOverage(claims: unknown): boolean {
  const c = claims as
    | { _claim_names?: unknown; hasgroups?: unknown }
    | null
    | undefined;
  if (!c || typeof c !== "object") return false;
  if (c.hasgroups === true) return true;
  const names = c._claim_names;
  return (
    typeof names === "object" &&
    names !== null &&
    "groups" in (names as Record<string, unknown>)
  );
}

/**
 * Sync a user's group memberships from the OIDC `groups` claim on sign-in.
 *
 * Takes the whole claims object, not just the claim value, because deciding
 * what an absent `groups` means requires seeing the overage markers that sit
 * beside it.
 *
 * Claim shape: `string[]`. Authentik emits group *names* directly here;
 * Keycloak and Okta likewise (with the right mappers configured). EntraID
 * emits object-id GUIDs by default — `cloud_displayname` gets you names, but
 * only under `groupMembershipClaims: "ApplicationGroup"`, and only for
 * directly assigned groups. See docs/oidc-entra-id.md §10a.
 *
 *   - whatever strings appear in the claim are treated as names verbatim
 *     and stored as-is. If your IdP emits GUIDs, the UI will show GUIDs;
 *     fix it at the IdP layer (we don't attempt resolution).
 *   - if the claim is missing/empty, the user is treated as having zero
 *     groups and all existing memberships are deleted. That is the
 *     conservative reading: don't keep stale grants alive once the IdP has
 *     stopped asserting them.
 *   - if the IdP signals an overage, we throw rather than apply either
 *     reading. See `detectGroupsOverage`.
 *
 * The whole operation runs in a single transaction so the membership
 * snapshot is atomic (no window where a user partially has new memberships
 * and still has stale ones).
 *
 * @throws {GroupsOverageError} when the claims carry an overage indicator.
 */
export async function syncUserGroupsFromClaim(
  userId: string,
  oidcIss: string,
  claims: unknown,
): Promise<void> {
  if (detectGroupsOverage(claims)) throw new GroupsOverageError();

  const rawClaim = (claims as { groups?: unknown } | null | undefined)?.groups;
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

