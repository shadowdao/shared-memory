import Link from "next/link";
import { notFound } from "next/navigation";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/lib/db/client";
import {
  groups,
  memories,
  projects,
  projectShares,
  users,
} from "@/lib/db/schema";
import {
  getProjectAccess,
  getUserGroupNames,
  readableProjectIds,
} from "@/lib/access";
import {
  addProjectShareAction,
  removeProjectShareAction,
  updateProjectShareAction,
} from "@/lib/share-actions";
import { Container, PageHeader } from "@/app/_components/ui/container";
import { Card, CardBody, CardHeader } from "@/app/_components/ui/card";
import { Badge } from "@/app/_components/ui/badge";
import { Button } from "@/app/_components/ui/button";
import { Input, Label } from "@/app/_components/ui/input";
import { EmptyState } from "@/app/_components/ui/empty-state";

export const dynamic = "force-dynamic";

/**
 * Project detail page.
 *
 * Three personas converge here:
 *   - Owner viewing their own project: full memory list + share-
 *     management UI.
 *   - Member of a group with rw access: same memory list, can edit
 *     memories, but cannot edit shares.
 *   - Member with ro access: memory list rendered read-only-ish; no
 *     "New memory" button.
 *
 * Authorization is centralised in `lib/access.ts` so this page only
 * has to ask "what's my access level" once and branch on the answer.
 */
export default async function ProjectDetailPage({
  params,
}: {
  params: Promise<{ key: string }>;
}) {
  const session = await auth();
  const userId = session!.user.id;
  const { key: rawKey } = await params;
  const key = decodeURIComponent(rawKey);
  const groupNames = await getUserGroupNames(userId);

  // Resolve the project. Prefer an owned project; otherwise look for a
  // shared project with this key the user can read. Mirrors the
  // MCP-side project.identify priority.
  const ownedRow = await db
    .select()
    .from(projects)
    .where(and(eq(projects.userId, userId), eq(projects.key, key)))
    .limit(1);

  let project = ownedRow[0];
  if (!project) {
    if (groupNames.length === 0) notFound();
    const readableIds = await readableProjectIds(userId, groupNames);
    if (readableIds.length === 0) notFound();
    const sharedRow = await db
      .select()
      .from(projects)
      .where(and(eq(projects.key, key), inArray(projects.id, readableIds)))
      .limit(1);
    if (!sharedRow[0]) notFound();
    project = sharedRow[0];
  }

  const access = await getProjectAccess(userId, groupNames, project.id);
  if (access === null) notFound();
  const isOwner = access === "owner";
  const canWrite = access === "owner" || access === "rw";

  // Owner display name for the page header. When the viewer IS the
  // owner we just say "Owned by you"; otherwise look up the owner.
  let ownerDisplayName: string | null = null;
  if (!isOwner) {
    const ownerRow = await db
      .select({ name: users.name, email: users.email })
      .from(users)
      .where(eq(users.id, project.userId))
      .limit(1);
    ownerDisplayName = ownerRow[0]?.name ?? ownerRow[0]?.email ?? "another user";
  }

  // All shares on this project, regardless of viewer's group memberships
  // — the owner needs to see everything; non-owners see the same list
  // for situational awareness.
  const shareRows = await db
    .select({
      groupId: groups.id,
      groupName: groups.name,
      access: projectShares.access,
      grantedAt: projectShares.grantedAt,
    })
    .from(projectShares)
    .innerJoin(groups, eq(groups.id, projectShares.groupId))
    .where(eq(projectShares.projectId, project.id))
    .orderBy(groups.name);

  // Memories: visible to owner + members alike — anyone with read
  // access on the project sees every memory under it. The query is
  // unchanged from the pre-sharing version; project_id is the gate.
  const mem = await db
    .select({
      id: memories.id,
      scope: memories.scope,
      content: memories.content,
      tags: memories.tags,
      createdAt: memories.createdAt,
    })
    .from(memories)
    .where(and(eq(memories.projectId, project.id), isNull(memories.deletedAt)))
    .orderBy(desc(memories.createdAt))
    .limit(100);

  // Groups the viewer is a member of — drives the share-add datalist
  // for owners (only show groups they could plausibly invite). Returns
  // an empty list when the user has no group memberships so the
  // datalist is simply absent rather than emitting a broken IN ().
  const myGroups =
    groupNames.length > 0
      ? await db
          .select({
            id: groups.id,
            name: groups.name,
            displayName: groups.displayName,
          })
          .from(groups)
          .where(inArray(groups.name, groupNames))
          .limit(50)
      : [];

  return (
    <Container className="pt-6">
      <PageHeader
        title={project.displayName ?? project.key}
        description={
          <span className="flex items-center gap-2 flex-wrap">
            <span className="font-mono">{project.key}</span>
            <span>·</span>
            <span>
              {mem.length} memor{mem.length === 1 ? "y" : "ies"}
            </span>
            <span>·</span>
            {isOwner ? (
              <Badge tone="success">Owned by you</Badge>
            ) : (
              <span className="text-fg-subtle">Owned by {ownerDisplayName}</span>
            )}
            {shareRows.length > 0 ? (
              <>
                <span>·</span>
                <Badge tone="accent">
                  Shared with {shareRows.length} group
                  {shareRows.length === 1 ? "" : "s"}
                </Badge>
              </>
            ) : null}
            {!isOwner ? (
              <>
                <span>·</span>
                <Badge tone={access === "rw" ? "success" : "neutral"}>
                  {access === "rw" ? "read + write" : "read only"}
                </Badge>
              </>
            ) : null}
          </span>
        }
        actions={
          <>
            <Link href="/projects" className="no-underline">
              <Button type="button" variant="secondary">All projects</Button>
            </Link>
            <Link
              href={`/projects/${encodeURIComponent(project.key)}/activity`}
              className="no-underline"
            >
              <Button type="button" variant="secondary">Activity</Button>
            </Link>
            {canWrite ? (
              <Link
                href={`/memories/new?project=${encodeURIComponent(project.key)}`}
                className="no-underline"
              >
                <Button>New in this project</Button>
              </Link>
            ) : null}
          </>
        }
      />

      <Card className="mb-6">
        <CardHeader className="flex items-center justify-between">
          <span className="text-sm font-medium">Auto-identify this project</span>
          <span className="text-xs text-fg-subtle">.shared-memory-project</span>
        </CardHeader>
        <CardBody className="space-y-2 text-sm">
          <p className="text-fg-muted">
            Commit a one-line text file at the repo root so every Claude Code
            session opened in this repo automatically targets this project —
            no per-machine config needed.
          </p>
          <pre className="!whitespace-pre-wrap text-xs">{`echo "${project.key}" > .shared-memory-project`}</pre>
          <p className="text-xs text-fg-subtle">
            Commit it. The directive tool descriptions tell Claude to read this
            file at session start before falling back to inference or the
            <code className="mx-1">X-Project-Key</code>header.
          </p>
        </CardBody>
      </Card>

      {shareRows.length > 0 || isOwner ? (
        <Card className="mb-6">
          <CardHeader className="flex items-center justify-between">
            <span className="text-sm font-medium">Sharing</span>
            <span className="text-xs text-fg-subtle">
              {shareRows.length === 0
                ? "No groups have access"
                : `${shareRows.length} group${shareRows.length === 1 ? "" : "s"}`}
            </span>
          </CardHeader>
          <CardBody className="space-y-3">
            {shareRows.length === 0 && !isOwner ? (
              <p className="text-sm text-fg-subtle">Only the owner has access.</p>
            ) : null}

            {shareRows.length > 0 ? (
              <ul className="divide-y divide-border">
                {shareRows.map((s) => (
                  <li
                    key={s.groupId}
                    className="flex items-center gap-3 py-2 text-sm"
                  >
                    <Badge tone="accent">{s.groupName}</Badge>
                    <Badge tone={s.access === "rw" ? "success" : "neutral"}>
                      {s.access}
                    </Badge>
                    <span className="text-xs text-fg-subtle">
                      since {new Date(s.grantedAt).toLocaleDateString()}
                    </span>
                    {isOwner ? (
                      <div className="ml-auto flex items-center gap-1">
                        <form action={updateProjectShareAction}>
                          <input type="hidden" name="projectKey" value={project.key} />
                          <input type="hidden" name="groupId" value={s.groupId} />
                          <input
                            type="hidden"
                            name="access"
                            value={s.access === "rw" ? "ro" : "rw"}
                          />
                          <Button
                            type="submit"
                            variant="secondary"
                            size="sm"
                            title={
                              s.access === "rw"
                                ? "Downgrade to read-only"
                                : "Promote to read-write"
                            }
                          >
                            {s.access === "rw" ? "→ ro" : "→ rw"}
                          </Button>
                        </form>
                        <form action={removeProjectShareAction}>
                          <input type="hidden" name="projectKey" value={project.key} />
                          <input type="hidden" name="groupId" value={s.groupId} />
                          <Button type="submit" variant="danger" size="sm">
                            Remove
                          </Button>
                        </form>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}

            {isOwner ? (
              <form
                action={addProjectShareAction}
                className="flex flex-wrap items-end gap-2 pt-2 border-t border-border"
              >
                <input type="hidden" name="projectKey" value={project.key} />
                <div className="flex-1 min-w-[200px]">
                  <Label htmlFor="groupName" hint="must be a group you're a member of">
                    Group name
                  </Label>
                  <Input
                    id="groupName"
                    name="groupName"
                    list="my-group-list"
                    placeholder="engineering"
                    required
                    className="mt-1"
                  />
                  {myGroups.length > 0 ? (
                    <datalist id="my-group-list">
                      {myGroups.map((g) => (
                        <option key={g.id} value={g.name}>
                          {g.displayName ?? g.name}
                        </option>
                      ))}
                    </datalist>
                  ) : null}
                </div>
                <div>
                  <Label>Access</Label>
                  <div className="mt-1 flex items-center gap-3 h-9">
                    <label className="text-sm flex items-center gap-1">
                      <input type="radio" name="access" value="ro" defaultChecked />
                      ro
                    </label>
                    <label className="text-sm flex items-center gap-1">
                      <input type="radio" name="access" value="rw" />
                      rw
                    </label>
                  </div>
                </div>
                <Button type="submit">Add share</Button>
              </form>
            ) : null}
          </CardBody>
        </Card>
      ) : null}

      {mem.length === 0 ? (
        <EmptyState
          title="No memories in this project yet"
          description={
            canWrite
              ? "Use the MCP from a Claude Code session, or create one here."
              : "Members with write access can add memories from the MCP or the Web UI."
          }
          action={
            canWrite ? (
              <Link
                href={`/memories/new?project=${encodeURIComponent(project.key)}`}
                className="no-underline"
              >
                <Button>Create the first one</Button>
              </Link>
            ) : null
          }
        />
      ) : (
        <ul className="space-y-2">
          {mem.map((m) => (
            <li key={m.id}>
              <Link href={`/memories/${m.id}`} className="block no-underline">
                <Card className="hover:border-border-strong transition-colors">
                  <CardBody className="space-y-2">
                    <div className="flex items-center gap-2 text-xs text-fg-subtle">
                      <Badge tone={m.scope === "user" ? "accent" : "neutral"}>
                        {m.scope}
                      </Badge>
                      {shareRows.length > 0 ? (
                        <Badge
                          tone="accent"
                          title={`Shared with ${shareRows.map((s) => s.groupName).join(", ")}`}
                        >
                          Shared
                        </Badge>
                      ) : null}
                      <span>{new Date(m.createdAt).toLocaleString()}</span>
                    </div>
                    <p className="text-sm text-fg line-clamp-3">{m.content}</p>
                    {m.tags.length ? (
                      <div className="flex gap-1 flex-wrap">
                        {m.tags.map((t) => (
                          <Badge key={t}>{t}</Badge>
                        ))}
                      </div>
                    ) : null}
                  </CardBody>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Container>
  );
}
