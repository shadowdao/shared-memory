import Link from "next/link";
import { and, desc, eq, inArray, isNull, or, sql, count } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/lib/db/client";
import { memories, projects, projectShares } from "@/lib/db/schema";
import { getUserGroupNames, readableProjectIds } from "@/lib/access";
import { Container, PageHeader } from "@/app/_components/ui/container";
import { Card, CardBody, CardHeader } from "@/app/_components/ui/card";
import { Badge } from "@/app/_components/ui/badge";
import { Button } from "@/app/_components/ui/button";
import { EmptyState } from "@/app/_components/ui/empty-state";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const session = await auth();
  const userId = session!.user.id;
  const groupNames = await getUserGroupNames(userId);

  // Visibility widening — recent + counts include memories under
  // projects shared with the user's groups.
  const accessibleIds = await readableProjectIds(userId, groupNames);
  const visibility =
    accessibleIds.length > 0
      ? or(eq(memories.userId, userId), inArray(memories.projectId, accessibleIds))
      : eq(memories.userId, userId);

  // Dashboard's "Projects" card stays owned-only — the list of projects
  // you actively own. Shared projects show up via the memory list and
  // the per-project page; surfacing them here would make the panel
  // confusing about who owns what.
  const [counts, recent, topProjects] = await Promise.all([
    db
      .select({
        total: count(memories.id),
      })
      .from(memories)
      .where(and(visibility!, isNull(memories.deletedAt))),
    db
      .select({
        id: memories.id,
        content: memories.content,
        scope: memories.scope,
        tags: memories.tags,
        createdAt: memories.createdAt,
        projectId: memories.projectId,
        projectKey: projects.key,
      })
      .from(memories)
      .leftJoin(projects, eq(memories.projectId, projects.id))
      .where(and(visibility!, isNull(memories.deletedAt)))
      .orderBy(desc(memories.createdAt))
      .limit(5),
    db
      .select({
        id: projects.id,
        key: projects.key,
        displayName: projects.displayName,
        memoryCount: sql<number>`count(${memories.id})::int`,
      })
      .from(projects)
      .leftJoin(
        memories,
        and(eq(memories.projectId, projects.id), isNull(memories.deletedAt)),
      )
      .where(eq(projects.userId, userId))
      .groupBy(projects.id)
      .orderBy(desc(sql`count(${memories.id})`))
      .limit(4),
  ]);

  // Annotate "Shared" chips on the recent panel.
  const projectIds = recent
    .map((r) => r.projectId)
    .filter((p): p is string => p !== null);
  const sharedProjects =
    projectIds.length > 0
      ? new Set(
          (
            await db
              .selectDistinct({ projectId: projectShares.projectId })
              .from(projectShares)
              .where(inArray(projectShares.projectId, projectIds))
          ).map((r) => r.projectId),
        )
      : new Set<string>();

  const memoryTotal = counts[0]?.total ?? 0;

  return (
    <Container className="pt-6">
      <PageHeader
        title={`Welcome, ${session!.user.name ?? session!.user.email ?? "there"}`}
        description={`${memoryTotal} memor${memoryTotal === 1 ? "y" : "ies"} across ${topProjects.length} project${topProjects.length === 1 ? "" : "s"}.`}
        actions={
          <Link href="/memories/new" className="no-underline">
            <Button>New memory</Button>
          </Link>
        }
      />

      <div className="grid gap-6 md:grid-cols-3">
        <section className="md:col-span-2 space-y-2">
          <h2 className="text-sm font-medium text-fg-muted mb-2">Recent</h2>
          {recent.length === 0 ? (
            <EmptyState
              title="No memories yet"
              description="Write one from the MCP, or create one here."
              action={
                <Link href="/memories/new" className="no-underline">
                  <Button>Create the first one</Button>
                </Link>
              }
            />
          ) : (
            recent.map((m) => (
              <Link
                key={m.id}
                href={`/memories/${m.id}`}
                className="block no-underline"
              >
                <Card className="hover:border-border-strong transition-colors">
                  <CardBody className="space-y-2">
                    <div className="flex items-center gap-2 text-xs text-fg-subtle">
                      <Badge tone={m.scope === "user" ? "accent" : "neutral"}>
                        {m.scope}
                      </Badge>
                      {m.projectId && sharedProjects.has(m.projectId) ? (
                        <Badge tone="accent" title="Shared with one or more groups">
                          Shared
                        </Badge>
                      ) : null}
                      {m.projectKey ? <span>· {m.projectKey}</span> : null}
                      <span className="ml-auto">
                        {new Date(m.createdAt).toLocaleDateString()}
                      </span>
                    </div>
                    <p className="text-sm text-fg line-clamp-2">{m.content}</p>
                    {m.tags.length ? (
                      <div className="flex gap-1 flex-wrap">
                        {m.tags.slice(0, 6).map((t) => (
                          <Badge key={t}>{t}</Badge>
                        ))}
                      </div>
                    ) : null}
                  </CardBody>
                </Card>
              </Link>
            ))
          )}
        </section>

        <section>
          <h2 className="text-sm font-medium text-fg-muted mb-2">Projects</h2>
          {topProjects.length === 0 ? (
            <p className="text-sm text-fg-subtle">No projects yet.</p>
          ) : (
            <Card>
              {topProjects.map((p, i) => (
                <Link
                  key={p.id}
                  href={`/projects/${encodeURIComponent(p.key)}`}
                  className={`block px-4 py-3 hover:bg-surface-2 no-underline ${i > 0 ? "border-t border-border" : ""}`}
                >
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm text-fg truncate">
                      {p.key}
                    </span>
                    <Badge className="ml-auto">{p.memoryCount}</Badge>
                  </div>
                  {p.displayName && p.displayName !== p.key ? (
                    <span className="block text-xs text-fg-muted truncate">
                      {p.displayName}
                    </span>
                  ) : null}
                </Link>
              ))}
              <Link
                href="/projects"
                className="block px-4 py-2 text-xs text-fg-muted border-t border-border hover:bg-surface-2 no-underline"
              >
                All projects →
              </Link>
            </Card>
          )}
        </section>
      </div>
    </Container>
  );
}
