import Link from "next/link";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/lib/db/client";
import { memories, projects } from "@/lib/db/schema";
import { getAccessibleProjects, getUserGroupNames } from "@/lib/access";
import { Container, PageHeader } from "@/app/_components/ui/container";
import { Card } from "@/app/_components/ui/card";
import { Badge } from "@/app/_components/ui/badge";
import { EmptyState } from "@/app/_components/ui/empty-state";

export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
  const session = await auth();
  const userId = session!.user.id;
  const groupNames = await getUserGroupNames(userId);

  // The project list is owned ∪ shared: projects the user owns PLUS
  // projects shared with one of their groups (any access). Visibility was
  // previously owner-only (`eq(projects.userId, userId)`), which hid
  // projects another user shared in via project_shares even though
  // project.identify already reported them as {shared, access}.
  const accessible = await getAccessibleProjects(userId, groupNames);
  const accessById = new Map(accessible.map((p) => [p.projectId, p.access]));
  const accessibleIds = accessible.map((p) => p.projectId);

  const rows =
    accessibleIds.length === 0
      ? []
      : await db
          .select({
            id: projects.id,
            key: projects.key,
            displayName: projects.displayName,
            createdAt: projects.createdAt,
            memoryCount: sql<number>`count(${memories.id})::int`,
            lastActivity: sql<Date | null>`max(${memories.createdAt})`,
          })
          .from(projects)
          .leftJoin(
            memories,
            and(eq(memories.projectId, projects.id), isNull(memories.deletedAt)),
          )
          .where(inArray(projects.id, accessibleIds))
          .groupBy(projects.id)
          .orderBy(desc(sql`max(${memories.createdAt})`));

  return (
    <Container className="pt-6">
      <PageHeader
        title="Projects"
        description={`${rows.length} project${rows.length === 1 ? "" : "s"}.`}
      />

      {rows.length === 0 ? (
        <EmptyState
          title="No projects yet"
          description="Projects are created automatically the first time you write a project-scoped memory or call project.identify from the MCP."
        />
      ) : (
        <Card>
          {rows.map((p, i) => (
            <Link
              key={p.id}
              href={`/projects/${encodeURIComponent(p.key)}`}
              className={`block px-4 py-3 hover:bg-surface-2 no-underline ${i > 0 ? "border-t border-border" : ""}`}
            >
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm text-fg truncate">{p.key}</span>
                    <Badge>{p.memoryCount}</Badge>
                    {accessById.get(p.id) !== "owner" ? (
                      <Badge tone="accent">shared · {accessById.get(p.id)}</Badge>
                    ) : null}
                  </div>
                  {p.displayName && p.displayName !== p.key ? (
                    <div className="text-xs text-fg-muted truncate mt-0.5">{p.displayName}</div>
                  ) : null}
                </div>
                <div className="text-xs text-fg-subtle whitespace-nowrap">
                  {p.lastActivity
                    ? `last write ${new Date(p.lastActivity).toLocaleDateString()}`
                    : "empty"}
                </div>
              </div>
            </Link>
          ))}
        </Card>
      )}
    </Container>
  );
}
