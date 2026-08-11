"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq, inArray } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/lib/db/client";
import { projects } from "@/lib/db/schema";
import { resolveProjectId, upsertProject } from "@/lib/projects";
import {
  MemoryWriteInput,
  MemoryUpdateInput,
  MemoryDeleteInput,
} from "@shared-memory/schemas";
import { getUserGroupNames, readableProjectIds } from "@/lib/access";
import {
  createMemory,
  softDeleteMemory,
  updateMemory,
  type Actor,
  type Outcome,
  type ProjectResolver,
} from "@/lib/memory-mutations";

/**
 * Server Actions for memory CRUD from the Web UI.
 *
 * These are thin adapters: form parsing, then `lib/memory-mutations`,
 * then revalidate/redirect. The authorize → mutate → re-embed → CAS →
 * audit sequence lives in that shared module so this surface and the MCP
 * tools cannot drift apart — they previously did, and the sharing rules
 * ended up subtly different between them.
 *
 * `actor` is "web" in audit_log so we can tell the two paths apart later.
 */

async function requireUserId(): Promise<string> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("not authenticated");
  return session.user.id;
}

/** Server Actions signal failure by throwing; the shared layer returns Outcome. */
function must<T>(outcome: Outcome<T>): T {
  if (!outcome.ok) throw new Error(outcome.error);
  return outcome.value;
}

async function webActor(): Promise<{ actor: Actor; resolveProject: ProjectResolver }> {
  const userId = await requireUserId();
  const groups = await getUserGroupNames(userId);
  return {
    actor: { userId, groups, via: "web" },
    resolveProject: webProjectResolver(userId, groups),
  };
}

/**
 * Project resolution for Web UI writes. Unlike the MCP surface, an
 * unknown key is CREATED rather than rejected — a person typing a project
 * name into a form means to make one. Shared projects are matched only
 * within the set the user can actually read, because `projects.key` is
 * unique per user rather than globally: an unscoped key match could
 * otherwise select someone else's project.
 *
 * Write access to whatever this returns is enforced centrally by the
 * mutation layer, so it deliberately isn't re-checked here.
 */
function webProjectResolver(userId: string, groupNames: string[]): ProjectResolver {
  return async (key: string) => {
    const owned = await resolveProjectId(userId, key);
    if (owned) return { ok: true, value: owned };

    const readableIds = await readableProjectIds(userId, groupNames);
    const shared =
      readableIds.length > 0
        ? await db
            .select({ id: projects.id })
            .from(projects)
            .where(and(eq(projects.key, key), inArray(projects.id, readableIds)))
            .limit(1)
        : [];
    if (shared[0]) return { ok: true, value: shared[0].id };

    return { ok: true, value: await upsertProject(userId, key) };
  };
}

function parseTags(raw: FormDataEntryValue | null): string[] {
  if (typeof raw !== "string") return [];
  return raw
    .split(/[,\s]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

export async function createMemoryAction(formData: FormData) {
  const { actor, resolveProject } = await webActor();

  const parsed = MemoryWriteInput.safeParse({
    content: String(formData.get("content") ?? "").trim(),
    scope: (formData.get("scope") as "project" | "user") || "project",
    project: (formData.get("project") as string | null)?.trim() || undefined,
    tags: parseTags(formData.get("tags")),
  });
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((i) => i.message).join("; "));
  }

  const created = must(await createMemory(actor, parsed.data, resolveProject));

  revalidatePath("/memories");
  redirect(`/memories/${created.id}`);
}

export async function updateMemoryAction(formData: FormData) {
  const { actor, resolveProject } = await webActor();

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

  must(await updateMemory(actor, parsed.data, resolveProject));

  revalidatePath(`/memories/${parsed.data.id}`);
  revalidatePath("/memories");
  redirect(`/memories/${parsed.data.id}`);
}

export async function deleteMemoryAction(formData: FormData) {
  const { actor } = await webActor();
  const id = String(formData.get("id") ?? "");
  const rawVersion = formData.get("version");
  const version =
    typeof rawVersion === "string" && rawVersion.length > 0
      ? Number.parseInt(rawVersion, 10)
      : undefined;
  const parsed = MemoryDeleteInput.safeParse({
    id,
    version: Number.isFinite(version) ? version : undefined,
  });
  if (!parsed.success) throw new Error(parsed.error.issues[0]!.message);

  must(await softDeleteMemory(actor, parsed.data));

  revalidatePath("/memories");
  redirect("/memories");
}
