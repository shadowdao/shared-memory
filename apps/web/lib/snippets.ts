import { and, arrayContains, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { snippets, projects } from "@/lib/db/schema";
import type { Snippet } from "@/lib/db/schema";
import {
  CONCURRENT_EDIT_ERROR_SNIPPET,
  canWriteProject,
  readableProjectIds,
} from "@/lib/access";

/**
 * Snippet data layer. Shared by the MCP tool handlers and the Web UI
 * Server Actions so both paths hit the same uniqueness / scope rules.
 *
 * Snippets are looked up by EXACT name — there is no search. Names are
 * unique within a scope:
 *   - user-scope: unique per (user_id)
 *   - project-scope: unique per (user_id, project_id)
 *
 * The same name CAN exist in both a user-scope row and one or more
 * project-scope rows for that user; callers disambiguate by passing
 * `scope` (+ `project` when project-scoped). When `scope` is omitted on
 * a get/delete, we prefer the project match (if `project` was supplied)
 * else fall back to the user-scope row.
 *
 * Sharing extends visibility: for project-scope rows, anyone who has
 * read access to the project sees the snippet; rw access is required
 * for putSnippet's update path and softDeleteSnippet.
 */

export const CONCURRENT_EDIT_ERROR = CONCURRENT_EDIT_ERROR_SNIPPET;

export interface ResolvedScope {
  scope: "project" | "user";
  projectId: string | null;
}

async function resolveProjectId(userId: string, key: string): Promise<string | null> {
  const row = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.userId, userId), eq(projects.key, key)))
    .limit(1);
  return row[0]?.id ?? null;
}

/**
 * Resolve a project id by key, preferring an owned project, falling
 * back to a shared project the user can read. Returns null if the key
 * matches nothing visible. Used by snippet lookups (which need to find
 * project-scope snippets under shared projects) — write authorization
 * is enforced separately by the caller via `canWriteProject`.
 */
async function resolveVisibleProjectId(
  userId: string,
  groupNames: string[],
  key: string,
): Promise<string | null> {
  const owned = await resolveProjectId(userId, key);
  if (owned) return owned;
  if (groupNames.length === 0) return null;
  const readableIds = await readableProjectIds(userId, groupNames);
  if (readableIds.length === 0) return null;
  const row = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.key, key), inArray(projects.id, readableIds)))
    .limit(1);
  return row[0]?.id ?? null;
}

async function upsertProject(userId: string, key: string): Promise<string> {
  const existing = await resolveProjectId(userId, key);
  if (existing) return existing;
  const row = await db
    .insert(projects)
    .values({ userId, key })
    .returning({ id: projects.id });
  return row[0]!.id;
}

export interface SnippetWithProjectKey extends Snippet {
  projectKey: string | null;
}

/**
 * Look up a snippet without enforcing ownership; visibility is restricted
 * by the WHERE clause to "owner" or "in a project the user can read".
 *
 * For user-scope snippets there's no sharing concept — they're personal.
 */
async function findSnippet(
  userId: string,
  groupNames: string[],
  name: string,
  scope: "project" | "user",
  projectId: string | null,
): Promise<SnippetWithProjectKey | null> {
  const where = [
    eq(snippets.name, name),
    eq(snippets.scope, scope),
    isNull(snippets.deletedAt),
  ];
  if (scope === "project") {
    if (!projectId) return null;
    where.push(eq(snippets.projectId, projectId));
    // Project-scope snippet: visibility = owner OR project is readable.
    // The caller has already resolved `projectId` via
    // `resolveVisibleProjectId`, so we only need to filter to that
    // project; any row under it is by definition visible to this user.
  } else {
    // User-scope snippet: strictly the caller's own row.
    where.push(eq(snippets.userId, userId));
    where.push(isNull(snippets.projectId));
  }
  const rows = await db
    .select({
      id: snippets.id,
      userId: snippets.userId,
      projectId: snippets.projectId,
      scope: snippets.scope,
      name: snippets.name,
      body: snippets.body,
      description: snippets.description,
      tags: snippets.tags,
      version: snippets.version,
      lastEditedBy: snippets.lastEditedBy,
      createdAt: snippets.createdAt,
      updatedAt: snippets.updatedAt,
      deletedAt: snippets.deletedAt,
      projectKey: projects.key,
    })
    .from(snippets)
    .leftJoin(projects, eq(snippets.projectId, projects.id))
    .where(and(...where))
    .limit(1);
  // groupNames is reserved for future per-group filtering paths; for
  // now project-scope visibility is already encoded by `projectId`.
  void groupNames;
  return (rows[0] as SnippetWithProjectKey | undefined) ?? null;
}

/**
 * Look up a single snippet by name. If `scope` is omitted, prefers a
 * project match (when `projectKey` is provided) and falls back to the
 * user-scope row. Returns null when nothing matches.
 *
 * `groupNames` widens project visibility to include shared projects.
 */
export async function getSnippet(
  userId: string,
  args: {
    name: string;
    scope?: "project" | "user";
    projectKey?: string;
    groupNames?: string[];
  },
): Promise<SnippetWithProjectKey | null> {
  const { name, scope, projectKey, groupNames = [] } = args;

  if (scope === "project") {
    if (!projectKey) return null;
    const pid = await resolveVisibleProjectId(userId, groupNames, projectKey);
    if (!pid) return null;
    return findSnippet(userId, groupNames, name, "project", pid);
  }

  if (scope === "user") {
    return findSnippet(userId, groupNames, name, "user", null);
  }

  // Scope unspecified: try project first if a key was given, then user.
  if (projectKey) {
    const pid = await resolveVisibleProjectId(userId, groupNames, projectKey);
    if (pid) {
      const projectHit = await findSnippet(userId, groupNames, name, "project", pid);
      if (projectHit) return projectHit;
    }
  }
  return findSnippet(userId, groupNames, name, "user", null);
}

/**
 * Upsert a snippet keyed by (scope, project, name). If a live row with
 * that key already exists, it's replaced in place — preserving its id
 * but bumping `version` and recording `last_edited_by`. Returns the
 * resulting row plus an `inserted` flag.
 *
 * Authorization:
 *   - user-scope: only the calling user can write.
 *   - project-scope: caller must own the project OR have rw access.
 *     When the project doesn't yet exist, it's auto-upserted with the
 *     caller as owner (matching memory-write semantics).
 *
 * Optimistic locking: pass `version` to require a CAS against the
 * current row's version on the update path. A 0-row update surfaces
 * `CONCURRENT_EDIT_ERROR_SNIPPET`. Ignored on insert.
 */
export async function putSnippet(
  userId: string,
  args: {
    name: string;
    body: string;
    description?: string;
    tags?: string[];
    scope: "project" | "user";
    projectKey?: string;
    groupNames?: string[];
    version?: number;
  },
): Promise<{ snippet: SnippetWithProjectKey; inserted: boolean }> {
  const { name, body, description, tags, scope, projectKey, groupNames = [], version } = args;

  let projectId: string | null = null;
  if (scope === "project") {
    if (!projectKey) throw new Error("scope=project requires projectKey");
    // Prefer owned; if a shared project exists with this key, require
    // rw to write through it; otherwise auto-upsert (caller-owned).
    const owned = await resolveProjectId(userId, projectKey);
    if (owned) {
      projectId = owned;
    } else {
      // Restrict by-key lookup to projects the user can actually read —
      // `projects.key` is unique per user, not globally, so an unscoped
      // match could resolve another user's project entirely.
      const readableIds = await readableProjectIds(userId, groupNames);
      const sharedRow =
        readableIds.length > 0
          ? await db
              .select({ id: projects.id })
              .from(projects)
              .where(
                and(eq(projects.key, projectKey), inArray(projects.id, readableIds)),
              )
              .limit(1)
          : [];
      if (sharedRow[0]) {
        const allowed = await canWriteProject(userId, groupNames, sharedRow[0].id);
        if (!allowed) {
          throw new Error(`no write access to project '${projectKey}'`);
        }
        projectId = sharedRow[0].id;
      } else {
        projectId = await upsertProject(userId, projectKey);
      }
    }
  }

  const existing = await findSnippet(userId, groupNames, name, scope, projectId);
  if (existing) {
    const updateValues: Record<string, unknown> = {
      body,
      tags: tags ?? existing.tags,
      updatedAt: new Date(),
      version: existing.version + 1,
      lastEditedBy: userId,
    };
    if (description !== undefined) updateValues.description = description;
    const expectedVersion = version ?? existing.version;
    const updated = await db
      .update(snippets)
      .set(updateValues)
      .where(and(eq(snippets.id, existing.id), eq(snippets.version, expectedVersion)))
      .returning({ id: snippets.id });
    if (!updated[0]) throw new Error(CONCURRENT_EDIT_ERROR_SNIPPET);
    const refreshed = await findSnippet(userId, groupNames, name, scope, projectId);
    return { snippet: refreshed!, inserted: false };
  }

  const inserted = await db
    .insert(snippets)
    .values({
      userId,
      projectId,
      scope,
      name,
      body,
      description: description ?? null,
      tags: tags ?? [],
      lastEditedBy: userId,
    })
    .returning({ id: snippets.id });

  const row = await db
    .select({
      id: snippets.id,
      userId: snippets.userId,
      projectId: snippets.projectId,
      scope: snippets.scope,
      name: snippets.name,
      body: snippets.body,
      description: snippets.description,
      tags: snippets.tags,
      version: snippets.version,
      lastEditedBy: snippets.lastEditedBy,
      createdAt: snippets.createdAt,
      updatedAt: snippets.updatedAt,
      deletedAt: snippets.deletedAt,
      projectKey: projects.key,
    })
    .from(snippets)
    .leftJoin(projects, eq(snippets.projectId, projects.id))
    .where(eq(snippets.id, inserted[0]!.id))
    .limit(1);

  return { snippet: row[0]! as SnippetWithProjectKey, inserted: true };
}

/**
 * List live snippets visible to this user, newest first. Visibility:
 *   - user-scope rows owned by `userId`
 *   - project-scope rows under a project the user can read (owner or
 *     any group share)
 *
 * Filters mirror memory.list. No pagination cursor yet — snippets are
 * expected to be relatively low-volume; we cap at the requested limit.
 */
export async function listSnippets(
  userId: string,
  args: {
    scope?: "project" | "user";
    projectKey?: string;
    tags?: string[];
    limit?: number;
    groupNames?: string[];
  } = {},
): Promise<SnippetWithProjectKey[]> {
  const { scope, projectKey, tags, limit = 50, groupNames = [] } = args;

  // Visibility: own user-scope rows OR project-scope rows under a
  // project the user can read.
  const visibleProjectIds = await readableProjectIds(userId, groupNames);
  const visibilityClause =
    visibleProjectIds.length > 0
      ? or(
          and(eq(snippets.userId, userId), isNull(snippets.projectId)),
          inArray(snippets.projectId, visibleProjectIds),
        )
      : and(eq(snippets.userId, userId), isNull(snippets.projectId));

  const where = [visibilityClause!, isNull(snippets.deletedAt)];

  if (scope) where.push(eq(snippets.scope, scope));

  if (projectKey) {
    const pid = await resolveVisibleProjectId(userId, groupNames, projectKey);
    if (!pid) return [];
    where.push(eq(snippets.projectId, pid));
  }

  if (tags && tags.length > 0) {
    // Require ALL listed tags (array containment). Use Drizzle's
    // arrayContains so the JS array binds as a single text[] param
    // (via the column's toDriver) rather than being expanded into
    // positional params — a raw `${tags}::text[]` template expands to
    // `($1)::text[]` / `($1,$2)::text[]`, which Postgres rejects as a
    // malformed array literal / record cast.
    where.push(arrayContains(snippets.tags, tags));
  }

  const rows = await db
    .select({
      id: snippets.id,
      userId: snippets.userId,
      projectId: snippets.projectId,
      scope: snippets.scope,
      name: snippets.name,
      body: snippets.body,
      description: snippets.description,
      tags: snippets.tags,
      version: snippets.version,
      lastEditedBy: snippets.lastEditedBy,
      createdAt: snippets.createdAt,
      updatedAt: snippets.updatedAt,
      deletedAt: snippets.deletedAt,
      projectKey: projects.key,
    })
    .from(snippets)
    .leftJoin(projects, eq(snippets.projectId, projects.id))
    .where(and(...where))
    .orderBy(desc(snippets.updatedAt))
    .limit(limit);

  return rows as SnippetWithProjectKey[];
}

/**
 * Soft-delete a snippet. Returns the deleted row's id, or null if
 * nothing matched (already deleted or never existed).
 *
 * If `scope` is omitted and `projectKey` is provided, deletes the
 * project-scope row (if found) — falls back to user-scope otherwise.
 *
 * Authorization mirrors `putSnippet`: project-scope rows require rw on
 * the project (or ownership); user-scope rows require ownership.
 */
export async function softDeleteSnippet(
  userId: string,
  args: {
    name: string;
    scope?: "project" | "user";
    projectKey?: string;
    groupNames?: string[];
    version?: number;
  },
): Promise<{ id: string; scope: "project" | "user"; projectKey: string | null } | null> {
  const { groupNames = [], version } = args;
  const target = await getSnippet(userId, args);
  if (!target) return null;

  // Authorize the delete. For user-scope, only the owner can delete;
  // `getSnippet` already filters to the user's own user-scope row, but
  // we double-check defensively in case the same name exists across
  // scopes and the caller passed scope=undefined.
  if (target.scope === "user") {
    if (target.userId !== userId) return null;
  } else if (target.projectId) {
    const allowed = await canWriteProject(userId, groupNames, target.projectId);
    if (!allowed) throw new Error("you don't have write access to this project");
  }

  // CAS on version so a peer's concurrent edit can't be silently dropped
  // by this delete. Caller-supplied version wins; else we use the version
  // we just read in `getSnippet` for in-handler consistency.
  const expectedVersion = version ?? target.version;
  const updated = await db
    .update(snippets)
    .set({ deletedAt: new Date(), lastEditedBy: userId })
    .where(and(eq(snippets.id, target.id), eq(snippets.version, expectedVersion)))
    .returning({ id: snippets.id });

  if (!updated[0]) {
    throw new Error(CONCURRENT_EDIT_ERROR_SNIPPET);
  }

  return {
    id: target.id,
    scope: target.scope,
    projectKey: target.projectKey,
  };
}

// Helpers re-exported so callers that need the project-id resolution
// don't have to duplicate the lookup logic.
export { resolveProjectId, upsertProject };
