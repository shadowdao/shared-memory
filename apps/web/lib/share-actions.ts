"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db/client";
import {
  auditLog,
  groups,
  projects,
  projectShares,
  userGroups,
} from "@/lib/db/schema";
import { MemoryAccess, ProjectKey } from "@shared-memory/schemas";

/**
 * Server Actions for project-sharing controls.
 *
 * The sharing model:
 *   - Only the project owner can grant, change, or revoke shares.
 *   - The granter can only share with groups they themselves belong to.
 *     This prevents leaking projects to arbitrary group names from the
 *     OIDC IdP — you can only invite people you'd already see in the
 *     mirror.
 *   - All three actions audit-log with actor='web' so the timeline of
 *     access changes survives a future schema change.
 *
 * Inputs are read from FormData (typical Next.js Server Action surface)
 * and validated with zod before any DB writes.
 */

async function requireUserId(): Promise<string> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("not authenticated");
  return session.user.id;
}

/**
 * Look up a project this user owns, by key. Returns null if it doesn't
 * exist or the caller isn't the owner. Owner-gating happens here rather
 * than in every action.
 */
async function resolveOwnedProject(
  userId: string,
  projectKey: string,
): Promise<{ id: string; key: string } | null> {
  const row = await db
    .select({ id: projects.id, key: projects.key })
    .from(projects)
    .where(and(eq(projects.userId, userId), eq(projects.key, projectKey)))
    .limit(1);
  return row[0] ?? null;
}

/**
 * Resolve a group by name AS LONG AS the caller is a member. This is
 * the leak-prevention check described above: an owner can't bestow
 * access on a group they themselves don't have visibility into.
 */
async function resolveGrantableGroup(
  userId: string,
  groupName: string,
): Promise<{ id: string; name: string } | null> {
  const row = await db
    .select({ id: groups.id, name: groups.name })
    .from(groups)
    .innerJoin(userGroups, eq(userGroups.groupId, groups.id))
    .where(and(eq(groups.name, groupName), eq(userGroups.userId, userId)))
    .limit(1);
  return row[0] ?? null;
}

const AddShareInput = z.object({
  projectKey: ProjectKey,
  groupName: z.string().min(1).max(200),
  access: MemoryAccess,
});

const UpdateShareInput = z.object({
  projectKey: ProjectKey,
  groupId: z.string().uuid(),
  access: MemoryAccess,
});

const RemoveShareInput = z.object({
  projectKey: ProjectKey,
  groupId: z.string().uuid(),
});

export async function addProjectShareAction(formData: FormData) {
  const userId = await requireUserId();

  const parsed = AddShareInput.safeParse({
    projectKey: String(formData.get("projectKey") ?? "").trim(),
    groupName: String(formData.get("groupName") ?? "").trim(),
    access: String(formData.get("access") ?? "ro"),
  });
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((i) => i.message).join("; "));
  }

  const project = await resolveOwnedProject(userId, parsed.data.projectKey);
  if (!project) throw new Error("project not found or you don't own it");

  const group = await resolveGrantableGroup(userId, parsed.data.groupName);
  if (!group) {
    throw new Error(
      `you must be a member of group '${parsed.data.groupName}' to share with it`,
    );
  }

  // Upsert: if a share already exists for (project, group), bump the
  // access level. This makes the "Add share" form double as a sanity-
  // safe re-grant path if a user accidentally re-adds the same group.
  await db
    .insert(projectShares)
    .values({
      projectId: project.id,
      groupId: group.id,
      access: parsed.data.access,
      grantedBy: userId,
    })
    .onConflictDoUpdate({
      target: [projectShares.projectId, projectShares.groupId],
      set: {
        access: parsed.data.access,
        grantedBy: userId,
        grantedAt: new Date(),
      },
    });

  await db.insert(auditLog).values({
    userId,
    actor: "web",
    action: "project.share.add",
    entityType: "project",
    entityId: project.id,
    payload: {
      projectKey: project.key,
      groupName: group.name,
      access: parsed.data.access,
    },
  });

  revalidatePath(`/projects/${encodeURIComponent(project.key)}`);
}

export async function updateProjectShareAction(formData: FormData) {
  const userId = await requireUserId();

  const parsed = UpdateShareInput.safeParse({
    projectKey: String(formData.get("projectKey") ?? "").trim(),
    groupId: String(formData.get("groupId") ?? "").trim(),
    access: String(formData.get("access") ?? "ro"),
  });
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((i) => i.message).join("; "));
  }

  const project = await resolveOwnedProject(userId, parsed.data.projectKey);
  if (!project) throw new Error("project not found or you don't own it");

  // The owner is allowed to flip any group's access — no membership
  // check required (only the add path requires it; ownership is enough
  // to twiddle an existing share). The row must exist.
  const existing = await db
    .select({ groupName: groups.name, access: projectShares.access })
    .from(projectShares)
    .innerJoin(groups, eq(groups.id, projectShares.groupId))
    .where(
      and(
        eq(projectShares.projectId, project.id),
        eq(projectShares.groupId, parsed.data.groupId),
      ),
    )
    .limit(1);
  if (!existing[0]) throw new Error("share not found");

  await db
    .update(projectShares)
    .set({ access: parsed.data.access, grantedBy: userId, grantedAt: new Date() })
    .where(
      and(
        eq(projectShares.projectId, project.id),
        eq(projectShares.groupId, parsed.data.groupId),
      ),
    );

  await db.insert(auditLog).values({
    userId,
    actor: "web",
    action: "project.share.update",
    entityType: "project",
    entityId: project.id,
    payload: {
      projectKey: project.key,
      groupName: existing[0].groupName,
      access: { from: existing[0].access, to: parsed.data.access },
    },
  });

  revalidatePath(`/projects/${encodeURIComponent(project.key)}`);
}

export async function removeProjectShareAction(formData: FormData) {
  const userId = await requireUserId();

  const parsed = RemoveShareInput.safeParse({
    projectKey: String(formData.get("projectKey") ?? "").trim(),
    groupId: String(formData.get("groupId") ?? "").trim(),
  });
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((i) => i.message).join("; "));
  }

  const project = await resolveOwnedProject(userId, parsed.data.projectKey);
  if (!project) throw new Error("project not found or you don't own it");

  const existing = await db
    .select({ groupName: groups.name, access: projectShares.access })
    .from(projectShares)
    .innerJoin(groups, eq(groups.id, projectShares.groupId))
    .where(
      and(
        eq(projectShares.projectId, project.id),
        eq(projectShares.groupId, parsed.data.groupId),
      ),
    )
    .limit(1);
  if (!existing[0]) throw new Error("share not found");

  await db
    .delete(projectShares)
    .where(
      and(
        eq(projectShares.projectId, project.id),
        eq(projectShares.groupId, parsed.data.groupId),
      ),
    );

  await db.insert(auditLog).values({
    userId,
    actor: "web",
    action: "project.share.remove",
    entityType: "project",
    entityId: project.id,
    payload: {
      projectKey: project.key,
      groupName: existing[0].groupName,
      access: existing[0].access,
    },
  });

  revalidatePath(`/projects/${encodeURIComponent(project.key)}`);
}
