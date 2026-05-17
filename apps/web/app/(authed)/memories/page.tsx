import Link from "next/link";
import { and, desc, eq, isNull, inArray, or, sql } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/lib/db/client";
import { memories, projects, projectShares } from "@/lib/db/schema";
import { searchMemories } from "@/lib/memories";
import { getUserGroupNames, readableProjectIds } from "@/lib/access";
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
  projectId: string | null;
  projectKey: string | null;
  content: string;
  tags: string[];
  createdAt: Date;
  rank?: { rrfScore: number; vectorRank: number | null; ftsRank: number | null; tagRank: number | null };
  shared?: boolean;
}

async function fetchMemoriesByIds(
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
      projectId: memories.projectId,
      projectKey: projects.key,
    })
    .from(memories)
    .leftJoin(projects, eq(memories.projectId, projects.id))
    .where(and(inArray(memories.id, ids), isNull(memories.deletedAt)));
  return new Map(rows.map((r) => [r.id, r as MemoryRow]));
}

async function listRecent(
  userId: string,
  groupNames: string[],
  scope?: Scope,
  project?: string,
): Promise<MemoryRow[]> {
  // Visibility: own rows OR rows in an accessible project.
  const accessibleIds = await readableProjectIds(userId, groupNames);
  const visibility =
    accessibleIds.length > 0
      ? or(eq(memories.userId, userId), inArray(memories.projectId, accessibleIds))
      : eq(memories.userId, userId);
  const filters = [visibility!, isNull(memories.deletedAt)];
  if (scope) filters.push(eq(memories.scope, scope));
  if (project) {
    // Project filter — match the project key against any project the
    // user can read (owned or shared). When the key matches none of
    // those, return empty.
    filters.push(
      sql`${memories.projectId} IN (
        SELECT id FROM ${projects}
        WHERE ${projects.key} = ${project}
          AND (${projects.userId} = ${userId}
               OR ${projects.id} = ANY(${accessibleIds}::uuid[]))
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
      projectId: memories.projectId,
      projectKey: projects.key,
    })
    .from(memories)
    .leftJoin(projects, eq(memories.projectId, projects.id))
    .where(and(...filters))
    .orderBy(desc(memories.createdAt))
    .limit(50);
  return rows;
}

/**
 * Lookup which projects in `projectIds` have any share rows. Used so
 * we can show a "Shared" chip per memory card. One query covers every
 * row on the page; per-row inspection would be N+1 here.
 */
async function sharedProjectSet(projectIds: string[]): Promise<Set<string>> {
  if (projectIds.length === 0) return new Set();
  const rows = await db
    .selectDistinct({ projectId: projectShares.projectId })
    .from(projectShares)
    .where(inArray(projectShares.projectId, projectIds));
  return new Set(rows.map((r) => r.projectId));
}

export default async function MemoriesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; scope?: string; project?: string }>;
}) {
  const session = await auth();
  const userId = session!.user.id;
  const groupNames = await getUserGroupNames(userId);
  const params = await searchParams;
  const q = params.q?.trim() || undefined;
  const scope = params.scope === "user" || params.scope === "project" ? params.scope : undefined;
  const project = params.project?.trim() || undefined;

  let rows: MemoryRow[] = [];
  let debug: { vec: number; fts: number; tag: number } | null = null;

  if (q) {
    const result = await searchMemories(
      userId,
      q,
      { scope, projectKey: project, groupNames },
      30,
    );
    const ids = result.hits.map((h) => h.id);
    const byId = await fetchMemoriesByIds(ids);
    rows = result.hits.flatMap((h) => {
      const r = byId.get(h.id);
      return r ? [{ ...r, rank: h.rank }] : [];
    });
    debug = result.debug;
  } else {
    rows = await listRecent(userId, groupNames, scope, project);
  }

  // Annotate which rows belong to projects that have any active share.
  // Done in a single query so the listing stays O(1) DB calls regardless
  // of page size.
  const projectIds = rows
    .map((r) => r.projectId)
    .filter((p): p is string => p !== null);
  const sharedProjects = await sharedProjectSet(projectIds);
  rows = rows.map((r) => ({
    ...r,
    shared: r.projectId ? sharedProjects.has(r.projectId) : false,
  }));

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
                      {m.shared ? (
                        <Badge tone="accent" title="Shared with one or more groups">
                          Shared
                        </Badge>
                      ) : null}
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
