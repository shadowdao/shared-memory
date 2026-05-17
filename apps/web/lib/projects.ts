import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { projects } from "@/lib/db/schema";

/**
 * Look up a project id by (user, key). Returns null when not found.
 * No write side-effects.
 */
export async function resolveProjectId(
  userId: string,
  key: string,
): Promise<string | null> {
  const row = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.userId, userId), eq(projects.key, key)))
    .limit(1);
  return row[0]?.id ?? null;
}

/**
 * Idempotent project creation. Returns the existing row's id when one
 * exists, otherwise inserts and returns the new id. Tolerates concurrent
 * inserts via ON CONFLICT — two simultaneous calls converge on one row.
 */
export async function upsertProject(
  userId: string,
  key: string,
  displayName?: string,
): Promise<string> {
  const existing = await resolveProjectId(userId, key);
  if (existing) return existing;
  const row = await db
    .insert(projects)
    .values({ userId, key, displayName: displayName ?? null })
    .onConflictDoNothing({ target: [projects.userId, projects.key] })
    .returning({ id: projects.id });
  if (row[0]) return row[0].id;
  // ON CONFLICT DO NOTHING returns no rows on conflict — re-read.
  const reread = await resolveProjectId(userId, key);
  if (!reread) throw new Error("project upsert raced and re-read still empty");
  return reread;
}
