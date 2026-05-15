import Link from "next/link";
import { and, desc, eq, isNull, inArray, sql } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/lib/db/client";
import { memories, projects } from "@/lib/db/schema";
import { searchMemories } from "@/lib/memories";
import { Container, PageHeader } from "@/app/_components/ui/container";
import { Card, CardBody } from "@/app/_components/ui/card";
import { Badge } from "@/app/_components/ui/badge";
import { Button } from "@/app/_components/ui/button";
import { Input } from "@/app/_components/ui/input";
import { EmptyState } from "@/app/_components/ui/empty-state";

export const dynamic = "force-dynamic";

type Scope = "project" | "user";

interface MemoryRow {
  id: string;
  scope: "project" | "user";
  projectKey: string | null;
  content: string;
  tags: string[];
  createdAt: Date;
  rank?: { rrfScore: number; vectorRank: number | null; ftsRank: number | null; tagRank: number | null };
}

async function fetchMemoriesByIds(
  userId: string,
  ids: string[],
): Promise<Map<string, MemoryRow>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      id: memories.id,
      scope: memories.scope,
      content: memories.content,
      tags: memories.tags,
      createdAt: memories.createdAt,
      projectKey: projects.key,
    })
    .from(memories)
    .leftJoin(projects, eq(memories.projectId, projects.id))
    .where(and(eq(memories.userId, userId), inArray(memories.id, ids), isNull(memories.deletedAt)));
  return new Map(rows.map((r) => [r.id, r as MemoryRow]));
}

async function listRecent(userId: string, scope?: Scope, project?: string): Promise<MemoryRow[]> {
  const filters = [eq(memories.userId, userId), isNull(memories.deletedAt)];
  if (scope) filters.push(eq(memories.scope, scope));
  if (project) {
    filters.push(
      sql`${memories.projectId} = (
        SELECT id FROM ${projects}
        WHERE ${projects.userId} = ${userId} AND ${projects.key} = ${project}
      )`,
    );
  }
  const rows = await db
    .select({
      id: memories.id,
      scope: memories.scope,
      content: memories.content,
      tags: memories.tags,
      createdAt: memories.createdAt,
      projectKey: projects.key,
    })
    .from(memories)
    .leftJoin(projects, eq(memories.projectId, projects.id))
    .where(and(...filters))
    .orderBy(desc(memories.createdAt))
    .limit(50);
  return rows;
}

export default async function MemoriesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; scope?: string; project?: string }>;
}) {
  const session = await auth();
  const userId = session!.user.id;
  const params = await searchParams;
  const q = params.q?.trim() || undefined;
  const scope = params.scope === "user" || params.scope === "project" ? params.scope : undefined;
  const project = params.project?.trim() || undefined;

  let rows: MemoryRow[] = [];
  let debug: { vec: number; fts: number; tag: number } | null = null;

  if (q) {
    const result = await searchMemories(userId, q, { scope, projectKey: project }, 30);
    const ids = result.hits.map((h) => h.id);
    const byId = await fetchMemoriesByIds(userId, ids);
    rows = result.hits.flatMap((h) => {
      const r = byId.get(h.id);
      return r ? [{ ...r, rank: h.rank }] : [];
    });
    debug = result.debug;
  } else {
    rows = await listRecent(userId, scope, project);
  }

  return (
    <Container className="pt-6">
      <PageHeader
        title="Memories"
        description={
          q
            ? `${rows.length} result${rows.length === 1 ? "" : "s"} for "${q}"`
            : "Most recent first."
        }
        actions={
          <Link href="/memories/new" className="no-underline">
            <Button>New memory</Button>
          </Link>
        }
      />

      <form
        method="GET"
        action="/memories"
        className="mb-6 flex flex-wrap items-center gap-2"
      >
        <Input
          name="q"
          placeholder="Search…"
          defaultValue={q ?? ""}
          aria-label="Search query"
          className="flex-1 min-w-[200px]"
        />
        <FilterSelect name="scope" value={scope} options={["", "project", "user"]} placeholder="Any scope" />
        <Input
          name="project"
          placeholder="Project key…"
          defaultValue={project ?? ""}
          className="w-44"
        />
        <Button type="submit" variant="secondary">Apply</Button>
      </form>

      {debug ? (
        <p className="text-xs text-fg-subtle mb-3">
          candidates · vector: {debug.vec} · fts: {debug.fts} · tag: {debug.tag}
        </p>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState
          title={q ? "Nothing matched" : "No memories yet"}
          description={q ? "Try a different query or remove filters." : "Create one or write via the MCP."}
          action={
            !q ? (
              <Link href="/memories/new" className="no-underline">
                <Button>Create the first one</Button>
              </Link>
            ) : null
          }
        />
      ) : (
        <ul className="space-y-2">
          {rows.map((m) => (
            <li key={m.id}>
              <Link href={`/memories/${m.id}`} className="block no-underline">
                <Card className="hover:border-border-strong transition-colors">
                  <CardBody className="space-y-2">
                    <div className="flex items-center gap-2 text-xs text-fg-subtle flex-wrap">
                      <Badge tone={m.scope === "user" ? "accent" : "neutral"}>
                        {m.scope}
                      </Badge>
                      {m.projectKey ? (
                        <span className="font-mono">· {m.projectKey}</span>
                      ) : null}
                      <span>·</span>
                      <span>{new Date(m.createdAt).toLocaleString()}</span>
                      {m.rank ? (
                        <span className="ml-auto text-fg-subtle">
                          rrf {m.rank.rrfScore.toFixed(4)} · v
                          {m.rank.vectorRank ?? "−"} · f
                          {m.rank.ftsRank ?? "−"} · t
                          {m.rank.tagRank ?? "−"}
                        </span>
                      ) : null}
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

function FilterSelect({
  name,
  value,
  options,
  placeholder,
}: {
  name: string;
  value: string | undefined;
  options: string[];
  placeholder: string;
}) {
  return (
    <select
      name={name}
      defaultValue={value ?? ""}
      className="h-9 px-2 rounded-md bg-surface-1 border border-border text-fg text-sm"
    >
      {options.map((o) => (
        <option key={o} value={o}>
          {o === "" ? placeholder : o}
        </option>
      ))}
    </select>
  );
}
