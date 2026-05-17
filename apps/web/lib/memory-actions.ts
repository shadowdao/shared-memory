"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq, isNull } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/lib/db/client";
import { memories, projects, auditLog } from "@/lib/db/schema";
import { embedText } from "@/lib/embedder";
import {
  MemoryWriteInput,
  MemoryUpdateInput,
  MemoryIdInput,
} from "@shared-memory/schemas";
import {
  CONCURRENT_EDIT_ERROR,
  canWriteProject,
  getUserGroupNames,
} from "@/lib/access";

/**
 * Server Actions for memory CRUD from the Web UI. Mirrors the MCP tools
 * but writes through the same DB layer, so updates and deletes here are
 * indistinguishable from those made via Claude Code.
 *
 * `actor` is "web" in audit_log so we can tell the two paths apart later.
 *
 * Sharing: project-scope memories may live under projects shared with
 * the user's groups. Reads include those projects; writes require the
 * user to own the project or have an `rw` share. Cross-user concurrent
 * edits use the `version` column for optimistic locking — if the stored
 * version no longer matches what the form submitted, we surface
 * `CONCURRENT_EDIT_ERROR` rather than clobber.
 */

async function requireUserId(): Promise<string> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("not authenticated");
  return session.user.id;
}

async function resolveProjectId(userId: string, key: string): Promise<string | null> {
  const row = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.userId, userId), eq(projects.key, key)))
    .limit(1);
  return row[0]?.id ?? null;
}

async function upsertProject(
  userId: string,
  key: string,
  displayName?: string,
): Promise<string> {
  const existing = await resolveProjectId(userId, key);
  if (existing) return existing;
  const row = await db
    .insert(projects)
    .values({ userId, key, displayName: displayName ?? null })
    .returning({ id: projects.id });
  return row[0]!.id;
}

function parseTags(raw: FormDataEntryValue | null): string[] {
  if (typeof raw !== "string") return [];
  return raw
    .split(/[,\s]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

export async function createMemoryAction(formData: FormData) {
  const userId = await requireUserId();
  const groupNames = await getUserGroupNames(userId);

  const payload = {
    content: String(formData.get("content") ?? "").trim(),
    scope: (formData.get("scope") as "project" | "user") || "project",
    project: (formData.get("project") as string | null)?.trim() || undefined,
    tags: parseTags(formData.get("tags")),
  };
  const parsed = MemoryWriteInput.safeParse(payload);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((i) => i.message).join("; "));
  }

  let projectId: string | null = null;
  if (parsed.data.scope === "project") {
    if (!parsed.data.project) throw new Error("scope=project requires `project`");
    // Same priority as memory.update's reclassification path: prefer an
    // owned project; otherwise check for a shared one we have rw on;
    // otherwise auto-upsert as owner.
    const owned = await resolveProjectId(userId, parsed.data.project);
    if (owned) {
      projectId = owned;
    } else {
      const sharedRow = await db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.key, parsed.data.project))
        .limit(1);
      if (sharedRow[0]) {
        const allowed = await canWriteProject(userId, groupNames, sharedRow[0].id);
        if (!allowed) {
          throw new Error(`no write access to project '${parsed.data.project}'`);
        }
        projectId = sharedRow[0].id;
      } else {
        projectId = await upsertProject(userId, parsed.data.project);
      }
    }
  }

  const embedding = await embedText(parsed.data.content);

  const inserted = await db
    .insert(memories)
    .values({
      userId,
      projectId,
      scope: parsed.data.scope,
      content: parsed.data.content,
      tags: parsed.data.tags ?? [],
      embedding,
      lastEditedBy: userId,
    })
    .returning({ id: memories.id });

  await db.insert(auditLog).values({
    userId,
    actor: "web",
    action: "memory.write",
    entityType: "memory",
    entityId: inserted[0]!.id,
    payload: {
      scope: parsed.data.scope,
      projectKey: parsed.data.project ?? null,
      tags: parsed.data.tags ?? [],
    },
  });

  revalidatePath("/memories");
  redirect(`/memories/${inserted[0]!.id}`);
}

export async function updateMemoryAction(formData: FormData) {
  const userId = await requireUserId();
  const groupNames = await getUserGroupNames(userId);

  const id = String(formData.get("id") ?? "");
  const rawScope = formData.get("scope");
  const rawProject = (formData.get("project") as string | null)?.trim() || undefined;
  const rawVersion = formData.get("version");
  const versionNum =
    typeof rawVersion === "string" && rawVersion.length > 0
      ? Number.parseInt(rawVersion, 10)
      : undefined;
  const payload = {
    id,
    content: ((formData.get("content") as string | null) ?? "").trim() || undefined,
    tags: parseTags(formData.get("tags")),
    scope:
      rawScope === "project" || rawScope === "user"
        ? (rawScope as "project" | "user")
        : undefined,
    project: rawProject,
    version: Number.isFinite(versionNum) ? versionNum : undefined,
  };
  const parsed = MemoryUpdateInput.safeParse(payload);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((i) => i.message).join("; "));
  }

  // Fetch the row regardless of ownership — we may be editing a shared
  // memory. Authorization is enforced below against the project, not
  // by `user_id`.
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
    .where(and(eq(memories.id, parsed.data.id), isNull(memories.deletedAt)))
    .limit(1);
  const existing = existingRows[0];
  if (!existing) throw new Error("not found");

  // Authorize write. For user-scope memories, only the owner can edit.
  // For project-scope memories, owner OR a group with rw access.
  if (existing.scope === "user") {
    if (existing.userId !== userId) throw new Error("not found");
  } else if (existing.projectId) {
    const allowed = await canWriteProject(userId, groupNames, existing.projectId);
    if (!allowed) {
      throw new Error("you don't have write access to this project");
    }
  }

  const update: Record<string, unknown> = {
    updatedAt: new Date(),
    lastEditedBy: userId,
    version: existing.version + 1,
  };
  if (parsed.data.tags !== undefined) update.tags = parsed.data.tags;
  if (parsed.data.content !== undefined && parsed.data.content !== existing.content) {
    update.content = parsed.data.content;
    update.embedding = await embedText(parsed.data.content);
  }

  let scopeChanged = false;
  let projectChanged = false;
  let newProjectKey: string | null = existing.projectKey ?? null;

  if (parsed.data.scope !== undefined) {
    if (parsed.data.scope === "user") {
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
      // scope === 'project' — schema refine guarantees project is set.
      // Moving INTO a project requires write access there. Owners get
      // a fresh project upsert; non-owners must target an existing one
      // they have rw on.
      const projectKey = parsed.data.project!;
      let projectId: string;
      const existingId = await resolveProjectId(userId, projectKey);
      if (existingId) {
        projectId = existingId;
      } else {
        // Try a shared project with this key.
        const sharedRow = await db
          .select({ id: projects.id })
          .from(projects)
          .where(eq(projects.key, projectKey))
          .limit(1);
        if (sharedRow[0]) {
          const allowed = await canWriteProject(userId, groupNames, sharedRow[0].id);
          if (!allowed) {
            throw new Error(`no write access to project '${projectKey}'`);
          }
          projectId = sharedRow[0].id;
        } else {
          // Auto-upsert as owner — user becomes the project owner of a
          // brand-new private project.
          projectId = await upsertProject(userId, projectKey);
        }
      }
      if (existing.scope !== "project") {
        update.scope = "project";
        scopeChanged = true;
      }
      if (existing.projectId !== projectId) {
        update.projectId = projectId;
        projectChanged = true;
        newProjectKey = projectKey;
      }
    }
  }

  // Optimistic-locking guard. When `version` is supplied, the UPDATE
  // matches on (id, version); a 0-row result means the caller's view
  // is stale. When `version` is NOT supplied, we still match on the
  // pre-fetched version to keep behaviour deterministic.
  const expectedVersion = parsed.data.version ?? existing.version;
  const updated = await db
    .update(memories)
    .set(update)
    .where(
      and(
        eq(memories.id, parsed.data.id),
        eq(memories.version, expectedVersion),
      ),
    )
    .returning({ id: memories.id });

  if (!updated[0]) throw new Error(CONCURRENT_EDIT_ERROR);

  const auditFields = Object.keys(update).filter(
    (k) => k !== "updatedAt" && k !== "version" && k !== "lastEditedBy",
  );
  const auditPayload: Record<string, unknown> = { fields: auditFields };
  if (scopeChanged || projectChanged) {
    auditPayload.scope = {
      from: existing.scope,
      to: update.scope ?? existing.scope,
    };
    auditPayload.projectKey = {
      from: existing.projectKey ?? null,
      to: newProjectKey,
    };
  }

  await db.insert(auditLog).values({
    userId,
    actor: "web",
    action: "memory.update",
    entityType: "memory",
    entityId: parsed.data.id,
    payload: auditPayload,
  });

  revalidatePath(`/memories/${parsed.data.id}`);
  revalidatePath("/memories");
  redirect(`/memories/${parsed.data.id}`);
}

export async function deleteMemoryAction(formData: FormData) {
  const userId = await requireUserId();
  const groupNames = await getUserGroupNames(userId);
  const id = String(formData.get("id") ?? "");
  const parsed = MemoryIdInput.safeParse({ id });
  if (!parsed.success) throw new Error(parsed.error.issues[0]!.message);

  // Authorize delete: same rule as update — owner OR rw on the project.
  const existing = await db
    .select({
      id: memories.id,
      scope: memories.scope,
      projectId: memories.projectId,
      userId: memories.userId,
    })
    .from(memories)
    .where(and(eq(memories.id, parsed.data.id), isNull(memories.deletedAt)))
    .limit(1);
  const row = existing[0];
  if (!row) throw new Error("not found");

  if (row.scope === "user") {
    if (row.userId !== userId) throw new Error("not found");
  } else if (row.projectId) {
    const allowed = await canWriteProject(userId, groupNames, row.projectId);
    if (!allowed) throw new Error("you don't have write access to this project");
  }

  const updated = await db
    .update(memories)
    .set({ deletedAt: new Date(), lastEditedBy: userId })
    .where(and(eq(memories.id, parsed.data.id), isNull(memories.deletedAt)))
    .returning({ id: memories.id });

  if (!updated[0]) throw new Error("not found");

  await db.insert(auditLog).values({
    userId,
    actor: "web",
    action: "memory.delete",
    entityType: "memory",
    entityId: updated[0].id,
  });

  revalidatePath("/memories");
  redirect("/memories");
}
