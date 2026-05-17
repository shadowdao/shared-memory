"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { db } from "@/lib/db/client";
import { auditLog } from "@/lib/db/schema";
import {
  SnippetPutInput,
  SnippetDeleteInput,
} from "@shared-memory/schemas";
import { putSnippet, softDeleteSnippet } from "@/lib/snippets";
import { getUserGroupNames } from "@/lib/access";

/**
 * Server Actions for snippet CRUD from the Web UI. Mirrors the MCP
 * tools but writes through the same DB helpers, so the two paths are
 * indistinguishable on the storage layer.
 *
 * `actor` is "web" in audit_log so we can tell the two paths apart later.
 *
 * Sharing: project-scope snippets under a shared project can be edited
 * by any user with rw access via this path; the `putSnippet` helper
 * enforces authorization and optimistic-locking concurrency control.
 */

async function requireUserId(): Promise<string> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("not authenticated");
  return session.user.id;
}

function parseTags(raw: FormDataEntryValue | null): string[] {
  if (typeof raw !== "string") return [];
  return raw
    .split(/[,\s]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

function targetUrl(scope: "project" | "user", name: string, projectKey: string | null): string {
  const params = new URLSearchParams({ scope });
  if (scope === "project" && projectKey) params.set("project", projectKey);
  return `/snippets/${encodeURIComponent(name)}?${params.toString()}`;
}

export async function createSnippetAction(formData: FormData) {
  const userId = await requireUserId();
  const groupNames = await getUserGroupNames(userId);

  const scope = (formData.get("scope") as "project" | "user") || "user";
  const projectRaw = (formData.get("project") as string | null)?.trim();
  const payload = {
    name: String(formData.get("name") ?? "").trim(),
    body: String(formData.get("body") ?? ""),
    description: ((formData.get("description") as string | null) ?? "").trim() || undefined,
    tags: parseTags(formData.get("tags")),
    scope,
    project: scope === "project" ? projectRaw || undefined : undefined,
  };

  const parsed = SnippetPutInput.safeParse(payload);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((i) => i.message).join("; "));
  }

  const { snippet, inserted } = await putSnippet(userId, {
    name: parsed.data.name,
    body: parsed.data.body,
    description: parsed.data.description,
    tags: parsed.data.tags,
    scope: parsed.data.scope,
    projectKey: parsed.data.project,
    groupNames,
  });

  await db.insert(auditLog).values({
    userId,
    actor: "web",
    action: inserted ? "snippet.put" : "snippet.update",
    entityType: "snippet",
    entityId: snippet.id,
    payload: {
      name: snippet.name,
      scope: snippet.scope,
      projectKey: snippet.projectKey,
      tags: snippet.tags,
    },
  });

  revalidatePath("/snippets");
  redirect(targetUrl(snippet.scope, snippet.name, snippet.projectKey));
}

export async function updateSnippetAction(formData: FormData) {
  const userId = await requireUserId();
  const groupNames = await getUserGroupNames(userId);

  // Edits keep the row's identity (scope + name + project unchanged) —
  // body/description/tags are what changes. Treat as a put on the same key.
  const scope = (formData.get("scope") as "project" | "user") || "user";
  const projectRaw = (formData.get("project") as string | null)?.trim();
  const rawVersion = formData.get("version");
  const versionNum =
    typeof rawVersion === "string" && rawVersion.length > 0
      ? Number.parseInt(rawVersion, 10)
      : undefined;
  const payload = {
    name: String(formData.get("name") ?? "").trim(),
    body: String(formData.get("body") ?? ""),
    description: ((formData.get("description") as string | null) ?? "").trim() || undefined,
    tags: parseTags(formData.get("tags")),
    scope,
    project: scope === "project" ? projectRaw || undefined : undefined,
    version: Number.isFinite(versionNum) ? versionNum : undefined,
  };

  const parsed = SnippetPutInput.safeParse(payload);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((i) => i.message).join("; "));
  }

  const { snippet } = await putSnippet(userId, {
    name: parsed.data.name,
    body: parsed.data.body,
    description: parsed.data.description,
    tags: parsed.data.tags,
    scope: parsed.data.scope,
    projectKey: parsed.data.project,
    groupNames,
    version: parsed.data.version,
  });

  await db.insert(auditLog).values({
    userId,
    actor: "web",
    action: "snippet.update",
    entityType: "snippet",
    entityId: snippet.id,
    payload: {
      name: snippet.name,
      scope: snippet.scope,
      projectKey: snippet.projectKey,
    },
  });

  revalidatePath("/snippets");
  revalidatePath(`/snippets/${encodeURIComponent(snippet.name)}`);
  redirect(targetUrl(snippet.scope, snippet.name, snippet.projectKey));
}

export async function deleteSnippetAction(formData: FormData) {
  const userId = await requireUserId();
  const groupNames = await getUserGroupNames(userId);

  const scope = formData.get("scope") as "project" | "user" | null;
  const projectRaw = (formData.get("project") as string | null)?.trim();
  const rawVersion = formData.get("version");
  const version =
    typeof rawVersion === "string" && rawVersion.length > 0
      ? Number.parseInt(rawVersion, 10)
      : undefined;
  const payload = {
    name: String(formData.get("name") ?? "").trim(),
    scope: scope ?? undefined,
    project: scope === "project" ? projectRaw || undefined : undefined,
    version: Number.isFinite(version) ? version : undefined,
  };

  const parsed = SnippetDeleteInput.safeParse(payload);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((i) => i.message).join("; "));
  }

  const deleted = await softDeleteSnippet(userId, {
    name: parsed.data.name,
    scope: parsed.data.scope,
    projectKey: parsed.data.project,
    groupNames,
    version: parsed.data.version,
  });
  if (!deleted) throw new Error("not found");

  await db.insert(auditLog).values({
    userId,
    actor: "web",
    action: "snippet.delete",
    entityType: "snippet",
    entityId: deleted.id,
    payload: {
      name: parsed.data.name,
      scope: deleted.scope,
      projectKey: deleted.projectKey,
    },
  });

  revalidatePath("/snippets");
  redirect("/snippets");
}
