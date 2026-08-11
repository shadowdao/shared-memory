import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { memories, projects, auditLog } from "@/lib/db/schema";
import { embedText } from "@/lib/embedder";
import { applyPatch } from "@/lib/memory-patch";
import { CONCURRENT_EDIT_ERROR, canWriteProject } from "@/lib/access";
import type {
  MemoryDeleteInput,
  MemoryPatchInput,
  MemoryUpdateInput,
  MemoryWriteInput,
} from "@shared-memory/schemas";

/**
 * The single write path for memories.
 *
 * Both surfaces — the MCP tools and the Web UI Server Actions — used to
 * reimplement authorize → mutate → re-embed → CAS → audit independently.
 * They drifted: `memory.delete` over MCP skipped the project ACL whenever
 * the caller happened to author the row, which `memory.update` and the
 * whole Web UI did not. Consolidating here is what keeps those rules in
 * one place, so a change to the sharing model can't be half-applied.
 *
 * Callers keep their own presentation concerns: MCP maps Outcome to a
 * ToolResult, the Web UI throws and then revalidates/redirects.
 */

export interface Actor {
  userId: string;
  /** Group names, for project-share authorization. */
  groups: string[];
  /** Recorded as audit_log.actor so the two surfaces stay distinguishable. */
  via: "web" | "mcp";
}

export type Outcome<T> = { ok: true; value: T } | { ok: false; error: string };

const fail = (error: string): Outcome<never> => ({ ok: false, error });
const succeed = <T>(value: T): Outcome<T> => ({ ok: true, value });

/**
 * Resolves a project key to an id for a write. Injected because this is
 * the one place the two surfaces genuinely, deliberately differ: MCP
 * refuses unknown projects (the caller is expected to run project.identify
 * first), while the Web UI creates one owned by the user. Everything else
 * about a write is identical.
 */
export type ProjectResolver = (key: string) => Promise<Outcome<string>>;

interface WriteTarget {
  scope: "project" | "user";
  projectId: string | null;
  userId: string;
}

/**
 * The authorization rule for every mutating operation:
 *   - user-scope  → only the owner may write (anything else reads as 404)
 *   - project-scope → owner of the project, or a group with `rw`
 *
 * Authoring a row grants nothing on its own. A memory you wrote while a
 * share was `rw` becomes read-only to you when an owner downgrades that
 * share to `ro` — the project ACL is the authority, not the byline.
 */
async function authorizeWrite(actor: Actor, row: WriteTarget): Promise<Outcome<null>> {
  if (row.scope === "user") {
    return row.userId === actor.userId ? succeed(null) : fail("not found");
  }
  if (row.projectId) {
    const allowed = await canWriteProject(actor.userId, actor.groups, row.projectId);
    if (!allowed) return fail("no write access to this project");
  }
  return succeed(null);
}

export async function createMemory(
  actor: Actor,
  input: MemoryWriteInput,
  resolveProject: ProjectResolver,
): Promise<Outcome<{ id: string; createdAt: Date }>> {
  let projectId: string | null = null;
  const projectKey = input.scope === "project" ? input.project : undefined;

  if (input.scope === "project") {
    if (!projectKey) return fail("scope=project requires `project`");
    const resolved = await resolveProject(projectKey);
    if (!resolved.ok) return resolved;
    projectId = resolved.value;
    const allowed = await canWriteProject(actor.userId, actor.groups, projectId);
    if (!allowed) return fail(`no write access to project '${projectKey}'`);
  }

  // Embed inline so the new memory is searchable immediately. Slower
  // writes (~50–150 ms) are an acceptable price for that guarantee.
  const embedding = await embedText(input.content);

  const inserted = await db
    .insert(memories)
    .values({
      userId: actor.userId,
      projectId,
      scope: input.scope,
      content: input.content,
      tags: input.tags ?? [],
      embedding,
      lastEditedBy: actor.userId,
    })
    .returning({ id: memories.id, createdAt: memories.createdAt });

  const row = inserted[0]!;
  await db.insert(auditLog).values({
    userId: actor.userId,
    actor: actor.via,
    action: "memory.write",
    entityType: "memory",
    entityId: row.id,
    payload: {
      scope: input.scope,
      projectKey: projectKey ?? null,
      tags: input.tags ?? [],
    },
  });

  return succeed(row);
}

export interface MutatedMemory {
  id: string;
  updatedAt: Date;
  version: number;
}

export async function updateMemory(
  actor: Actor,
  input: MemoryUpdateInput,
  resolveProject: ProjectResolver,
): Promise<Outcome<MutatedMemory>> {
  const existingRows = await db
    .select({
      id: memories.id,
      content: memories.content,
      scope: memories.scope,
      projectId: memories.projectId,
      projectKey: projects.key,
      version: memories.version,
      userId: memories.userId,
    })
    .from(memories)
    .leftJoin(projects, eq(memories.projectId, projects.id))
    .where(and(eq(memories.id, input.id), isNull(memories.deletedAt)))
    .limit(1);
  const existing = existingRows[0];
  if (!existing) return fail("not found");

  const authorized = await authorizeWrite(actor, existing);
  if (!authorized.ok) return authorized;

  const update: Record<string, unknown> = {
    updatedAt: new Date(),
    lastEditedBy: actor.userId,
    version: existing.version + 1,
  };
  if (input.tags !== undefined) update.tags = input.tags;
  if (input.content !== undefined && input.content !== existing.content) {
    update.content = input.content;
    update.embedding = await embedText(input.content);
  }

  let scopeChanged = false;
  let projectChanged = false;
  let newProjectKey: string | null = existing.projectKey ?? null;

  if (input.scope !== undefined) {
    if (input.scope === "user") {
      if (existing.scope !== "user") {
        update.scope = "user";
        scopeChanged = true;
      }
      if (existing.projectId !== null) {
        update.projectId = null;
        projectChanged = true;
        newProjectKey = null;
      }
    } else {
      // scope === 'project' — the schema refine guarantees `project` is set.
      // Moving INTO a project requires write access there.
      const projectKey = input.project!;
      const resolved = await resolveProject(projectKey);
      if (!resolved.ok) return resolved;
      const targetId = resolved.value;
      const allowed = await canWriteProject(actor.userId, actor.groups, targetId);
      if (!allowed) return fail(`no write access to project '${projectKey}'`);

      if (existing.scope !== "project") {
        update.scope = "project";
        scopeChanged = true;
      }
      if (existing.projectId !== targetId) {
        update.projectId = targetId;
        projectChanged = true;
        newProjectKey = projectKey;
      }
    }
  }

  const updated = await casUpdate(input.id, update, input.version ?? existing.version);
  if (!updated) return fail(CONCURRENT_EDIT_ERROR);

  const auditFields = Object.keys(update).filter(
    (k) => k !== "updatedAt" && k !== "version" && k !== "lastEditedBy",
  );
  const auditPayload: Record<string, unknown> = { fields: auditFields };
  if (scopeChanged || projectChanged) {
    auditPayload.scope = { from: existing.scope, to: update.scope ?? existing.scope };
    auditPayload.projectKey = { from: existing.projectKey ?? null, to: newProjectKey };
  }

  await db.insert(auditLog).values({
    userId: actor.userId,
    actor: actor.via,
    action: "memory.update",
    entityType: "memory",
    entityId: updated.id,
    payload: auditPayload,
  });

  return succeed(updated);
}

export async function patchMemory(
  actor: Actor,
  input: MemoryPatchInput,
): Promise<Outcome<MutatedMemory & { contentLength: number; delta: number }>> {
  const existingRows = await db
    .select({
      content: memories.content,
      scope: memories.scope,
      projectId: memories.projectId,
      version: memories.version,
      userId: memories.userId,
    })
    .from(memories)
    .where(and(eq(memories.id, input.id), isNull(memories.deletedAt)))
    .limit(1);
  const existing = existingRows[0];
  if (!existing) return fail("not found");

  const authorized = await authorizeWrite(actor, existing);
  if (!authorized.ok) return authorized;

  const patch = applyPatch(existing.content, input.old_string, input.new_string);
  if (!patch.ok) return fail(patch.error);

  const updated = await casUpdate(
    input.id,
    {
      content: patch.content,
      embedding: await embedText(patch.content),
      updatedAt: new Date(),
      lastEditedBy: actor.userId,
      version: existing.version + 1,
    },
    input.version ?? existing.version,
  );
  if (!updated) return fail(CONCURRENT_EDIT_ERROR);

  await db.insert(auditLog).values({
    userId: actor.userId,
    actor: actor.via,
    action: "memory.patch",
    entityType: "memory",
    entityId: updated.id,
    payload: {
      fields: ["content"],
      patch: {
        offset: existing.content.indexOf(input.old_string),
        removed: input.old_string.length,
        added: input.new_string.length,
      },
    },
  });

  return succeed({
    ...updated,
    contentLength: patch.content.length,
    delta: patch.content.length - existing.content.length,
  });
}

export async function softDeleteMemory(
  actor: Actor,
  input: MemoryDeleteInput,
): Promise<Outcome<{ id: string }>> {
  const rows = await db
    .select({
      id: memories.id,
      userId: memories.userId,
      projectId: memories.projectId,
      scope: memories.scope,
      version: memories.version,
    })
    .from(memories)
    .where(and(eq(memories.id, input.id), isNull(memories.deletedAt)))
    .limit(1);
  const existing = rows[0];
  if (!existing) return fail("not found");

  const authorized = await authorizeWrite(actor, existing);
  if (!authorized.ok) return authorized;

  const updated = await db
    .update(memories)
    .set({ deletedAt: new Date(), lastEditedBy: actor.userId })
    .where(
      and(
        eq(memories.id, input.id),
        eq(memories.version, input.version ?? existing.version),
        isNull(memories.deletedAt),
      ),
    )
    .returning({ id: memories.id });

  if (!updated[0]) return fail(CONCURRENT_EDIT_ERROR);

  await db.insert(auditLog).values({
    userId: actor.userId,
    actor: actor.via,
    action: "memory.delete",
    entityType: "memory",
    entityId: updated[0].id,
  });

  return succeed(updated[0]);
}

/**
 * Compare-and-set on `version`. A zero-row result means a peer edited the
 * row between our read and this write. Callers that omit an explicit
 * version pass the one they just read, which still closes the read-
 * modify-write window inside a single handler.
 */
async function casUpdate(
  id: string,
  update: Record<string, unknown>,
  expectedVersion: number,
): Promise<MutatedMemory | null> {
  const rows = await db
    .update(memories)
    .set(update)
    .where(and(eq(memories.id, id), eq(memories.version, expectedVersion)))
    .returning({
      id: memories.id,
      updatedAt: memories.updatedAt,
      version: memories.version,
    });
  return rows[0] ?? null;
}
