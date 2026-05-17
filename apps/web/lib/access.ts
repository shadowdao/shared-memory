import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  groups,
  projects,
  projectShares,
  userGroups,
} from "@/lib/db/schema";

/**
 * Authorization helpers for the project-sharing model.
 *
 * Access semantics:
 *   - Owner (projects.user_id = U.id): full read + write.
 *   - Group share (project_shares.group_id in U.groups):
 *       access='ro' → read only
 *       access='rw' → read + write
 *
 * Lookups in this module are intentionally cheap and small — they only
 * resolve project_ids the user can touch. Per-row queries embed those
 * ids in their WHERE clauses (or use IN subqueries) so the database still
 * does the heavy lifting; we never load all-of-project-X into memory to
 * filter in JS.
 *
 * Why a separate module: callers come from three places
 * (`memory-actions`, `snippet-actions`, `mcp/tools`, plus the `lib/`
 * search/list helpers), and replicating the same SQL three ways was
 * the previous source of inconsistency this phase fixes.
 */

export type ProjectAccess = "owner" | "ro" | "rw";

export interface AccessibleProject {
  projectId: string;
  access: ProjectAccess;
  projectKey: string;
}

/**
 * Resolve the set of project ids `userId` can read, with the strongest
 * access level for each. Owner > rw > ro. Used by listing/search paths
 * that need to widen their WHERE clauses to include shared projects.
 *
 * Group names are matched case-sensitively against the `groups` table —
 * the OIDC claim names are the contract. An empty `groupNames` is fine;
 * the user just won't see any shared projects.
 */
export async function getAccessibleProjects(
  userId: string,
  groupNames: string[],
): Promise<AccessibleProject[]> {
  const owned = await db
    .select({ projectId: projects.id, projectKey: projects.key })
    .from(projects)
    .where(eq(projects.userId, userId));

  const ownedMap = new Map<string, AccessibleProject>(
    owned.map((r) => ({
      projectId: r.projectId,
      access: "owner" as const,
      projectKey: r.projectKey,
    })).map((r) => [r.projectId, r] as const),
  );

  if (groupNames.length === 0) {
    return [...ownedMap.values()];
  }

  // Join project_shares → groups → projects so we get the project key
  // alongside the access level in a single query.
  const shared = await db
    .select({
      projectId: projectShares.projectId,
      access: projectShares.access,
      projectKey: projects.key,
    })
    .from(projectShares)
    .innerJoin(groups, eq(groups.id, projectShares.groupId))
    .innerJoin(projects, eq(projects.id, projectShares.projectId))
    .where(inArray(groups.name, groupNames));

  // If two of the user's groups both share the same project at different
  // levels, keep the strongest: owner > rw > ro. The DB may emit the same
  // project twice (once per group), so we collapse by taking the max.
  for (const r of shared) {
    const prior = ownedMap.get(r.projectId);
    if (prior?.access === "owner" || prior?.access === "rw") continue;
    ownedMap.set(r.projectId, {
      projectId: r.projectId,
      access: r.access as "ro" | "rw",
      projectKey: r.projectKey,
    });
  }

  return [...ownedMap.values()];
}

/**
 * Resolve project access for a single project_id. Returns null when the
 * user has no access at all (deny by default). Owner check is short-
 * circuited: we don't query project_shares unless the user isn't owner.
 */
export async function getProjectAccess(
  userId: string,
  groupNames: string[],
  projectId: string,
): Promise<ProjectAccess | null> {
  const owned = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .limit(1);
  if (owned[0]) return "owner";

  if (groupNames.length === 0) return null;

  const sharedRows = await db
    .select({ access: projectShares.access })
    .from(projectShares)
    .innerJoin(groups, eq(groups.id, projectShares.groupId))
    .where(
      and(
        eq(projectShares.projectId, projectId),
        inArray(groups.name, groupNames),
      ),
    );

  if (sharedRows.length === 0) return null;
  // If a user is in multiple groups with different levels on the same
  // project, pick the strongest.
  return sharedRows.some((r) => r.access === "rw") ? "rw" : "ro";
}

/**
 * "Can this user read project P?" — true for owner, ro, or rw.
 */
export async function canReadProject(
  userId: string,
  groupNames: string[],
  projectId: string,
): Promise<boolean> {
  const access = await getProjectAccess(userId, groupNames, projectId);
  return access !== null;
}

/**
 * "Can this user write to project P?" — true for owner or rw share.
 */
export async function canWriteProject(
  userId: string,
  groupNames: string[],
  projectId: string,
): Promise<boolean> {
  const access = await getProjectAccess(userId, groupNames, projectId);
  return access === "owner" || access === "rw";
}

/**
 * Project ids that this user has READ access to (own + any shared). Used
 * by candidate-fetch WHERE clauses on listings and search. The empty
 * set is encoded explicitly: callers should treat it as "no rows".
 */
export async function readableProjectIds(
  userId: string,
  groupNames: string[],
): Promise<string[]> {
  const all = await getAccessibleProjects(userId, groupNames);
  return all.map((p) => p.projectId);
}

/**
 * Project ids that this user has WRITE access to (own + rw shares).
 */
export async function writableProjectIds(
  userId: string,
  groupNames: string[],
): Promise<string[]> {
  const all = await getAccessibleProjects(userId, groupNames);
  return all.filter((p) => p.access !== "ro").map((p) => p.projectId);
}

/**
 * The error message returned to any caller that lost an optimistic-
 * locking race. Centralized so the wording stays consistent across MCP
 * tools and Server Actions; callers also key off the prefix to surface
 * a "Refresh" UI affordance if they care.
 */
export const CONCURRENT_EDIT_ERROR =
  "Memory was modified by someone else since you loaded it. Refresh and try again.";

export const CONCURRENT_EDIT_ERROR_SNIPPET =
  "Snippet was modified by someone else since you loaded it. Refresh and try again.";

/**
 * Fetch the group names this user is currently a member of from the
 * `user_groups` table. Used by Web UI Server Actions and pages — the
 * web session's JWT may carry the same list, but reading from the DB
 * means we don't have to coordinate with Agent A's session-callback
 * change to consume sharing semantics here. Agent A's sign-in callback
 * keeps `user_groups` in sync with the OIDC `groups` claim.
 */
export async function getUserGroupNames(userId: string): Promise<string[]> {
  const rows = await db
    .select({ name: groups.name })
    .from(userGroups)
    .innerJoin(groups, eq(groups.id, userGroups.groupId))
    .where(eq(userGroups.userId, userId));
  return rows.map((r) => r.name);
}
