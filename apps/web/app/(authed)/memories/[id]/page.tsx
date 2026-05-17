import Link from "next/link";
import { notFound } from "next/navigation";
import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/lib/db/client";
import { memories, projects, projectShares, groups, users } from "@/lib/db/schema";
import { updateMemoryAction, deleteMemoryAction } from "@/lib/memory-actions";
import { getProjectAccess, getUserGroupNames, readableProjectIds } from "@/lib/access";
import { Container, PageHeader } from "@/app/_components/ui/container";
import { Card, CardBody, CardHeader } from "@/app/_components/ui/card";
import { Input, Textarea, Label } from "@/app/_components/ui/input";
import { Button } from "@/app/_components/ui/button";
import { Badge } from "@/app/_components/ui/badge";

export const dynamic = "force-dynamic";

export default async function MemoryDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ edit?: string }>;
}) {
  const session = await auth();
  const userId = session!.user.id;
  const groupNames = await getUserGroupNames(userId);
  const { id } = await params;
  const { edit } = await searchParams;

  // Widen the visibility predicate: a user can see a memory they own,
  // or any memory whose project is shared with them. Project_id filter
  // uses the precomputed accessible-id list for parity with the search
  // / list paths.
  const accessibleProjectIds = await readableProjectIds(userId, groupNames);
  const visibility =
    accessibleProjectIds.length > 0
      ? or(
          eq(memories.userId, userId),
          inArray(memories.projectId, accessibleProjectIds),
        )
      : eq(memories.userId, userId);

  const rows = await db
    .select({
      id: memories.id,
      scope: memories.scope,
      content: memories.content,
      tags: memories.tags,
      version: memories.version,
      lastEditedBy: memories.lastEditedBy,
      createdAt: memories.createdAt,
      updatedAt: memories.updatedAt,
      projectKey: projects.key,
      projectId: memories.projectId,
      ownerUserId: memories.userId,
    })
    .from(memories)
    .leftJoin(projects, eq(memories.projectId, projects.id))
    .where(and(eq(memories.id, id), isNull(memories.deletedAt), visibility!))
    .limit(1);

  const m = rows[0];
  if (!m) notFound();

  // Determine the viewer's write permission. user-scope memories =
  // owner-only; project-scope = canWriteProject. Used to gate the
  // Edit / Delete affordances.
  let canWrite: boolean;
  if (m.scope === "user") {
    canWrite = m.ownerUserId === userId;
  } else if (m.projectId) {
    const access = await getProjectAccess(userId, groupNames, m.projectId);
    canWrite = access === "owner" || access === "rw";
  } else {
    canWrite = false;
  }

  const isEditing = edit === "1" && canWrite;

  // Shares on this project drive the "Shared" chip plus an editor-name
  // lookup (we want to display who last edited, even if they're another
  // member of the same group).
  const shareRows = m.projectId
    ? await db
        .select({ groupName: groups.name })
        .from(projectShares)
        .innerJoin(groups, eq(groups.id, projectShares.groupId))
        .where(eq(projectShares.projectId, m.projectId))
    : [];

  const editorRow = m.lastEditedBy
    ? await db
        .select({ name: users.name, email: users.email })
        .from(users)
        .where(eq(users.id, m.lastEditedBy))
        .limit(1)
    : [];
  const editorLabel = editorRow[0]
    ? editorRow[0].name ?? editorRow[0].email ?? "unknown"
    : null;

  const projectList = isEditing
    ? await db
        .select({ key: projects.key, displayName: projects.displayName })
        .from(projects)
        .where(eq(projects.userId, userId))
        .orderBy(desc(projects.updatedAt))
        .limit(50)
    : [];

  return (
    <Container className="pt-6 max-w-3xl">
      <PageHeader
        title={isEditing ? "Edit memory" : "Memory"}
        description={<span className="font-mono text-xs text-fg-subtle">{m.id}</span>}
        actions={
          <>
            <Link href="/memories" className="no-underline">
              <Button type="button" variant="secondary">Back</Button>
            </Link>
            {!isEditing && canWrite ? (
              <Link href={`/memories/${m.id}?edit=1`} className="no-underline">
                <Button>Edit</Button>
              </Link>
            ) : null}
          </>
        }
      />

      <Card className="mb-4">
        <CardHeader className="flex items-center gap-2 text-xs text-fg-muted flex-wrap">
          <Badge tone={m.scope === "user" ? "accent" : "neutral"}>{m.scope}</Badge>
          {m.projectKey ? <span className="font-mono">{m.projectKey}</span> : null}
          {shareRows.length > 0 ? (
            <Badge
              tone="accent"
              title={`Shared with ${shareRows.map((s) => s.groupName).join(", ")}`}
            >
              Shared
            </Badge>
          ) : null}
          <span>· Created {new Date(m.createdAt).toLocaleString()}</span>
          {m.updatedAt.getTime() !== m.createdAt.getTime() ? (
            <span>· Updated {new Date(m.updatedAt).toLocaleString()}</span>
          ) : null}
          {editorLabel && m.lastEditedBy !== m.ownerUserId ? (
            <span className="text-fg-subtle">
              · Last edited by {editorLabel}
            </span>
          ) : null}
        </CardHeader>

        {isEditing ? (
          <CardBody>
            <form action={updateMemoryAction} className="space-y-4">
              <input type="hidden" name="id" value={m.id} />
              <input type="hidden" name="version" value={m.version} />
              <div>
                <Label htmlFor="scope">Scope</Label>
                <select
                  id="scope"
                  name="scope"
                  defaultValue={m.scope}
                  className="mt-1 h-9 px-2 rounded-md bg-surface-1 border border-border text-fg text-sm w-full"
                >
                  <option value="project">Project — attached to a project</option>
                  <option value="user">User — global across all projects</option>
                </select>
              </div>
              <div>
                <Label htmlFor="project" hint="Required for project scope">
                  Project key
                </Label>
                <Input
                  id="project"
                  name="project"
                  defaultValue={m.projectKey ?? ""}
                  placeholder="repo name, slug, or any stable string"
                  list="project-list"
                  className="mt-1"
                />
                {projectList.length > 0 ? (
                  <datalist id="project-list">
                    {projectList.map((p) => (
                      <option key={p.key} value={p.key}>
                        {p.displayName ?? p.key}
                      </option>
                    ))}
                  </datalist>
                ) : null}
              </div>
              <div>
                <Label htmlFor="content">Content</Label>
                <Textarea
                  id="content"
                  name="content"
                  required
                  rows={12}
                  defaultValue={m.content}
                  className="mt-1"
                />
              </div>
              <div>
                <Label htmlFor="tags" hint="comma- or space-separated">Tags</Label>
                <Input
                  id="tags"
                  name="tags"
                  defaultValue={m.tags.join(", ")}
                  className="mt-1"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Link href={`/memories/${m.id}`} className="no-underline">
                  <Button type="button" variant="secondary">Cancel</Button>
                </Link>
                <Button type="submit">Save changes</Button>
              </div>
            </form>
          </CardBody>
        ) : (
          <CardBody>
            <pre className="whitespace-pre-wrap break-words bg-transparent border-0 p-0 text-sm text-fg leading-relaxed">
              {m.content}
            </pre>
            {m.tags.length ? (
              <div className="flex gap-1 flex-wrap mt-4">
                {m.tags.map((t) => (
                  <Badge key={t}>{t}</Badge>
                ))}
              </div>
            ) : null}
          </CardBody>
        )}
      </Card>

      {!isEditing && canWrite ? (
        <form action={deleteMemoryAction} className="flex justify-end">
          <input type="hidden" name="id" value={m.id} />
          <input type="hidden" name="version" value={m.version} />
          <Button type="submit" variant="danger" size="sm">
            Delete memory
          </Button>
        </form>
      ) : null}
    </Container>
  );
}
