import Link from "next/link";
import { notFound } from "next/navigation";
import { and, desc, eq, isNull } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/lib/db/client";
import { memories, projects } from "@/lib/db/schema";
import { Container, PageHeader } from "@/app/_components/ui/container";
import { Card, CardBody } from "@/app/_components/ui/card";
import { Badge } from "@/app/_components/ui/badge";
import { Button } from "@/app/_components/ui/button";
import { EmptyState } from "@/app/_components/ui/empty-state";

export const dynamic = "force-dynamic";

export default async function ProjectDetailPage({
  params,
}: {
  params: Promise<{ key: string }>;
}) {
  const session = await auth();
  const userId = session!.user.id;
  const { key: rawKey } = await params;
  const key = decodeURIComponent(rawKey);

  const projectRow = await db
    .select()
    .from(projects)
    .where(and(eq(projects.userId, userId), eq(projects.key, key)))
    .limit(1);
  const project = projectRow[0];
  if (!project) notFound();

  const mem = await db
    .select({
      id: memories.id,
      scope: memories.scope,
      content: memories.content,
      tags: memories.tags,
      createdAt: memories.createdAt,
    })
    .from(memories)
    .where(
      and(
        eq(memories.userId, userId),
        eq(memories.projectId, project.id),
        isNull(memories.deletedAt),
      ),
    )
    .orderBy(desc(memories.createdAt))
    .limit(100);

  return (
    <Container className="pt-6">
      <PageHeader
        title={project.displayName ?? project.key}
        description={
          <>
            <span className="font-mono">{project.key}</span>
            {" · "}
            {mem.length} memor{mem.length === 1 ? "y" : "ies"}
          </>
        }
        actions={
          <>
            <Link href="/projects" className="no-underline">
              <Button type="button" variant="secondary">All projects</Button>
            </Link>
            <Link
              href={`/memories/new?project=${encodeURIComponent(project.key)}`}
              className="no-underline"
            >
              <Button>New in this project</Button>
            </Link>
          </>
        }
      />

      {mem.length === 0 ? (
        <EmptyState
          title="No memories in this project yet"
          description="Use the MCP from a Claude Code session, or create one here."
          action={
            <Link
              href={`/memories/new?project=${encodeURIComponent(project.key)}`}
              className="no-underline"
            >
              <Button>Create the first one</Button>
            </Link>
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
