import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { snippets, projects } from "@/lib/db/schema";
import type { Snippet } from "@/lib/db/schema";

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
 */

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

async function findSnippet(
  userId: string,
  name: string,
  scope: "project" | "user",
  projectId: string | null,
): Promise<SnippetWithProjectKey | null> {
  const where = [
    eq(snippets.userId, userId),
    eq(snippets.name, name),
    eq(snippets.scope, scope),
    isNull(snippets.deletedAt),
  ];
  if (scope === "project") {
    if (!projectId) return null;
    where.push(eq(snippets.projectId, projectId));
  } else {
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
      createdAt: snippets.createdAt,
      updatedAt: snippets.updatedAt,
      deletedAt: snippets.deletedAt,
      projectKey: projects.key,
    })
    .from(snippets)
    .leftJoin(projects, eq(snippets.projectId, projects.id))
    .where(and(...where))
    .limit(1);
  return (rows[0] as SnippetWithProjectKey | undefined) ?? null;
}

/**
 * Look up a single snippet by name. If `scope` is omitted, prefers a
 * project match (when `projectKey` is provided) and falls back to the
 * user-scope row. Returns null when nothing matches.
 */
export async function getSnippet(
  userId: string,
  args: {
    name: string;
    scope?: "project" | "user";
    projectKey?: string;
  },
): Promise<SnippetWithProjectKey | null> {
  const { name, scope, projectKey } = args;

  if (scope === "project") {
    if (!projectKey) return null;
    const pid = await resolveProjectId(userId, projectKey);
    if (!pid) return null;
    return findSnippet(userId, name, "project", pid);
  }

  if (scope === "user") {
    return findSnippet(userId, name, "user", null);
  }

  // Scope unspecified: try project first if a key was given, then user.
  if (projectKey) {
    const pid = await resolveProjectId(userId, projectKey);
    if (pid) {
      const projectHit = await findSnippet(userId, name, "project", pid);
      if (projectHit) return projectHit;
    }
  }
  return findSnippet(userId, name, "user", null);
}

/**
 * Upsert a snippet keyed by (user, scope, project, name). If the row
 * already exists (live, matching scope), it's replaced in place
 * preserving its id. Returns the resulting row plus an `inserted` flag.
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
  },
): Promise<{ snippet: SnippetWithProjectKey; inserted: boolean }> {
  const { name, body, description, tags, scope, projectKey } = args;

  let projectId: string | null = null;
  if (scope === "project") {
    if (!projectKey) throw new Error("scope=project requires projectKey");
    projectId = await upsertProject(userId, projectKey);
  }

  const existing = await findSnippet(userId, name, scope, projectId);
  if (existing) {
    const updateValues: Record<string, unknown> = {
      body,
      tags: tags ?? existing.tags,
      updatedAt: new Date(),
    };
    if (description !== undefined) updateValues.description = description;
    await db
      .update(snippets)
      .set(updateValues)
      .where(and(eq(snippets.id, existing.id), eq(snippets.userId, userId)));
    const refreshed = await findSnippet(userId, name, scope, projectId);
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
 * List live snippets for this user, newest first. Filters mirror
 * memory.list. No pagination cursor yet — snippets are expected to be
 * relatively low-volume; we cap at the requested limit.
 */
export async function listSnippets(
  userId: string,
  args: {
    scope?: "project" | "user";
    projectKey?: string;
    tags?: string[];
    limit?: number;
  } = {},
): Promise<SnippetWithProjectKey[]> {
  const { scope, projectKey, tags, limit = 50 } = args;
  const where = [eq(snippets.userId, userId), isNull(snippets.deletedAt)];

  if (scope) where.push(eq(snippets.scope, scope));

  if (projectKey) {
    const pid = await resolveProjectId(userId, projectKey);
    if (!pid) return [];
    where.push(eq(snippets.projectId, pid));
  }

  if (tags && tags.length > 0) {
    where.push(sql`${snippets.tags} @> ${tags}::text[]`);
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
 */
export async function softDeleteSnippet(
  userId: string,
  args: {
    name: string;
    scope?: "project" | "user";
    projectKey?: string;
  },
): Promise<{ id: string; scope: "project" | "user"; projectKey: string | null } | null> {
  const target = await getSnippet(userId, args);
  if (!target) return null;

  await db
    .update(snippets)
    .set({ deletedAt: new Date() })
    .where(eq(snippets.id, target.id));

  return {
    id: target.id,
    scope: target.scope,
    projectKey: target.projectKey,
  };
}

// Helpers re-exported so callers that need the project-id resolution
// don't have to duplicate the lookup logic.
export { resolveProjectId, upsertProject };
