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

/**
 * Server Actions for memory CRUD from the Web UI. Mirrors the MCP tools
 * but writes through the same DB layer, so updates and deletes here are
 * indistinguishable from those made via Claude Code.
 *
 * `actor` is "web" in audit_log so we can tell the two paths apart later.
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
    projectId = await upsertProject(userId, parsed.data.project);
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

  const id = String(formData.get("id") ?? "");
  const rawScope = formData.get("scope");
  const rawProject = (formData.get("project") as string | null)?.trim() || undefined;
  const payload = {
    id,
    content: ((formData.get("content") as string | null) ?? "").trim() || undefined,
    tags: parseTags(formData.get("tags")),
    scope:
      rawScope === "project" || rawScope === "user"
        ? (rawScope as "project" | "user")
        : undefined,
    project: rawProject,
  };
  const parsed = MemoryUpdateInput.safeParse(payload);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((i) => i.message).join("; "));
  }

  const existingRows = await db
    .select({
      id: memories.id,
      content: memories.content,
      scope: memories.scope,
      projectId: memories.projectId,
      projectKey: projects.key,
    })
    .from(memories)
    .leftJoin(projects, eq(memories.projectId, projects.id))
    .where(
      and(eq(memories.id, parsed.data.id), eq(memories.userId, userId), isNull(memories.deletedAt)),
    )
    .limit(1);
  const existing = existingRows[0];
  if (!existing) throw new Error("not found");

  const update: Record<string, unknown> = { updatedAt: new Date() };
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
      // scope === 'project' — schema refine guarantees project is set
      const projectKey = parsed.data.project!;
      const projectId = await upsertProject(userId, projectKey);
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

  await db.update(memories).set(update).where(eq(memories.id, parsed.data.id));

  const auditFields = Object.keys(update).filter((k) => k !== "updatedAt");
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
  const id = String(formData.get("id") ?? "");
  const parsed = MemoryIdInput.safeParse({ id });
  if (!parsed.success) throw new Error(parsed.error.issues[0]!.message);

  const updated = await db
    .update(memories)
    .set({ deletedAt: new Date() })
    .where(
      and(eq(memories.id, parsed.data.id), eq(memories.userId, userId), isNull(memories.deletedAt)),
    )
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
