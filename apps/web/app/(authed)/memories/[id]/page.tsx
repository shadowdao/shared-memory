import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq, isNull } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/lib/db/client";
import { memories, projects } from "@/lib/db/schema";
import { updateMemoryAction, deleteMemoryAction } from "@/lib/memory-actions";
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
  const { id } = await params;
  const { edit } = await searchParams;

  const rows = await db
    .select({
      id: memories.id,
      scope: memories.scope,
      content: memories.content,
      tags: memories.tags,
      createdAt: memories.createdAt,
      updatedAt: memories.updatedAt,
      projectKey: projects.key,
      projectId: memories.projectId,
    })
    .from(memories)
    .leftJoin(projects, eq(memories.projectId, projects.id))
    .where(
      and(eq(memories.id, id), eq(memories.userId, userId), isNull(memories.deletedAt)),
    )
    .limit(1);

  const m = rows[0];
  if (!m) notFound();

  const isEditing = edit === "1";

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
            {!isEditing ? (
              <Link href={`/memories/${m.id}?edit=1`} className="no-underline">
                <Button>Edit</Button>
              </Link>
            ) : null}
          </>
        }
      />

      <Card className="mb-4">
        <CardHeader className="flex items-center gap-2 text-xs text-fg-muted">
          <Badge tone={m.scope === "user" ? "accent" : "neutral"}>{m.scope}</Badge>
          {m.projectKey ? <span className="font-mono">{m.projectKey}</span> : null}
          <span>· Created {new Date(m.createdAt).toLocaleString()}</span>
          {m.updatedAt.getTime() !== m.createdAt.getTime() ? (
            <span>· Updated {new Date(m.updatedAt).toLocaleString()}</span>
          ) : null}
        </CardHeader>

        {isEditing ? (
          <CardBody>
            <form action={updateMemoryAction} className="space-y-4">
              <input type="hidden" name="id" value={m.id} />
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

      {!isEditing ? (
        <form action={deleteMemoryAction} className="flex justify-end">
          <input type="hidden" name="id" value={m.id} />
          <Button type="submit" variant="danger" size="sm">
            Delete memory
          </Button>
        </form>
      ) : null}
    </Container>
  );
}
