import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq, inArray } from "drizzle-orm";
import { auth } from "@/auth";
import { db, pg } from "@/lib/db/client";
import { projects, users } from "@/lib/db/schema";
import { getProjectAccess, getUserGroupNames, readableProjectIds } from "@/lib/access";
import { Container, PageHeader } from "@/app/_components/ui/container";
import { Card, CardBody } from "@/app/_components/ui/card";
import { Badge } from "@/app/_components/ui/badge";
import { Button } from "@/app/_components/ui/button";
import { EmptyState } from "@/app/_components/ui/empty-state";

export const dynamic = "force-dynamic";

const ROW_LIMIT = 150;

interface ActivityRow {
  id: string;
  action: string;
  actor: "mcp" | "web" | "system";
  entityType: "memory" | "snippet" | "project" | string;
  entityId: string | null;
  userId: string | null;
  payload: Record<string, unknown> | null;
  createdAt: Date;
}

/**
 * Per-project activity feed. Surfaces every audit_log row that pertains
 * to this project — memory writes/updates/deletes, snippet puts/deletes,
 * share grants/revocations/changes, identify-collision warnings.
 *
 * Query strategy: three UNION ALL legs joined to a single audit_log
 * source, ordered + limited at the end. Avoids relying on the audit
 * payload's projectKey field, which isn't populated for every action
 * shape today.
 */
export default async function ProjectActivityPage({
  params,
}: {
  params: Promise<{ key: string }>;
}) {
  const session = await auth();
  const userId = session!.user.id;
  const { key: rawKey } = await params;
  const key = decodeURIComponent(rawKey);
  const groupNames = await getUserGroupNames(userId);

  // Resolve the project: prefer owned, fall back to shared.
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

  // Pull every audit_log row that concerns this project. Three legs:
  //  - memory rows joined by entity_id → memories.id where the memory's
  //    current project_id matches
  //  - snippet rows joined likewise
  //  - project rows where entity_id is the project itself (share grants
  //    and project.identify.collision)
  // postgres-js's tagged template returns parsed JSON for jsonb columns.
  const rows = await pg<ActivityRow[]>`
    SELECT al.id, al.action, al.actor, al.entity_type AS "entityType",
           al.entity_id AS "entityId", al.user_id AS "userId",
           al.payload, al.created_at AS "createdAt"
      FROM audit_log al
      JOIN memories m ON al.entity_id = m.id
     WHERE al.entity_type = 'memory'
       AND m.project_id = ${project.id}
    UNION ALL
    SELECT al.id, al.action, al.actor, al.entity_type,
           al.entity_id, al.user_id, al.payload, al.created_at
      FROM audit_log al
      JOIN snippets s ON al.entity_id = s.id
     WHERE al.entity_type = 'snippet'
       AND s.project_id = ${project.id}
    UNION ALL
    SELECT al.id, al.action, al.actor, al.entity_type,
           al.entity_id, al.user_id, al.payload, al.created_at
      FROM audit_log al
     WHERE al.entity_type = 'project'
       AND al.entity_id = ${project.id}
    ORDER BY "createdAt" DESC
    LIMIT ${ROW_LIMIT}
  `;

  // Bulk-resolve user display names. `userId` can be null for system
  // entries (project.identify.collision); skip those.
  const userIds = [...new Set(rows.map((r) => r.userId).filter((id): id is string => Boolean(id)))];
  const userById = new Map<string, { name: string | null; email: string | null }>();
  if (userIds.length > 0) {
    const userRows = await db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(inArray(users.id, userIds));
    for (const u of userRows) {
      userById.set(u.id, { name: u.name, email: u.email });
    }
  }

  function actorLabel(row: ActivityRow): string {
    if (row.actor === "system") return "system";
    if (!row.userId) return "(unknown user)";
    const u = userById.get(row.userId);
    if (!u) return "(unknown user)";
    return u.name ?? u.email ?? row.userId;
  }

  return (
    <Container className="pt-6 max-w-4xl">
      <PageHeader
        title="Activity"
        description={
          <>
            <span className="font-mono">{project.key}</span>
            {" · "}
            <span>{rows.length} event{rows.length === 1 ? "" : "s"}</span>
            {rows.length === ROW_LIMIT ? <span> (most recent first)</span> : null}
          </>
        }
        actions={
          <Link
            href={`/projects/${encodeURIComponent(project.key)}`}
            className="no-underline"
          >
            <Button type="button" variant="secondary">Back to project</Button>
          </Link>
        }
      />

      {rows.length === 0 ? (
        <EmptyState
          title="No activity yet"
          description="Memory writes, snippet edits, and share changes will show up here as they happen."
        />
      ) : (
        <Card>
          <ol className="divide-y divide-border">
            {rows.map((row) => (
              <li key={row.id} className="px-4 py-3 flex items-baseline gap-3">
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-fg">
                    <strong className="font-medium">{actorLabel(row)}</strong>{" "}
                    <span className="text-fg-muted">{describeAction(row)}</span>
                  </div>
                  {renderPayloadSummary(row)}
                </div>
                <div className="text-xs text-fg-subtle whitespace-nowrap" title={row.createdAt.toString()}>
                  {formatRelative(row.createdAt)}
                </div>
              </li>
            ))}
          </ol>
        </Card>
      )}
    </Container>
  );
}

/**
 * Human-friendly verb phrase per action. Includes an entity link when
 * the entity is still resolvable (memory/snippet id), plain text
 * otherwise. Keeps deletes phrased in the past tense so the feed reads
 * as a log.
 */
function describeAction(row: ActivityRow): React.ReactNode {
  switch (row.action) {
    case "memory.write":
      return (
        <>
          wrote{" "}
          {row.entityId ? (
            <Link href={`/memories/${row.entityId}`} className="no-underline">
              a memory
            </Link>
          ) : (
            "a memory"
          )}
        </>
      );
    case "memory.update": {
      const fields = (row.payload?.fields as string[] | undefined) ?? [];
      const fieldList = fields.length > 0 ? ` (${fields.join(", ")})` : "";
      return (
        <>
          edited{" "}
          {row.entityId ? (
            <Link href={`/memories/${row.entityId}`} className="no-underline">
              a memory
            </Link>
          ) : (
            "a memory"
          )}
          {fieldList}
        </>
      );
    }
    case "memory.delete":
      return <>deleted a memory</>;
    case "snippet.put":
    case "snippet.update": {
      const name = (row.payload?.name as string | undefined) ?? null;
      const verb = row.action === "snippet.put" ? "saved" : "edited";
      return (
        <>
          {verb} snippet{" "}
          {name ? <code className="text-fg">{name}</code> : <em>(unnamed)</em>}
        </>
      );
    }
    case "snippet.delete": {
      const name = (row.payload?.name as string | undefined) ?? null;
      return (
        <>
          deleted snippet{" "}
          {name ? <code className="text-fg">{name}</code> : <em>(unnamed)</em>}
        </>
      );
    }
    case "project.share.add": {
      const groupName = (row.payload?.groupName as string | undefined) ?? "(unknown group)";
      const access = (row.payload?.access as string | undefined) ?? "?";
      return (
        <>
          shared with <strong className="font-medium">{groupName}</strong>{" "}
          <Badge tone={access === "rw" ? "success" : "neutral"}>{access}</Badge>
        </>
      );
    }
    case "project.share.update": {
      const groupName = (row.payload?.groupName as string | undefined) ?? "(unknown group)";
      const access = (row.payload?.access as string | undefined) ?? "?";
      return (
        <>
          changed <strong className="font-medium">{groupName}</strong>{"'s "}access to{" "}
          <Badge tone={access === "rw" ? "success" : "neutral"}>{access}</Badge>
        </>
      );
    }
    case "project.share.remove": {
      const groupName = (row.payload?.groupName as string | undefined) ?? "(unknown group)";
      return (
        <>
          stopped sharing with <strong className="font-medium">{groupName}</strong>
        </>
      );
    }
    case "project.identify.collision":
      return (
        <>
          project key collided with a shared project of the same name (owned won)
        </>
      );
    default:
      return <>{row.action}</>;
  }
}

/**
 * Optional second line for richer payloads — scope transitions and tag
 * changes on memory.update, mainly. Kept terse so the feed scans well.
 */
function renderPayloadSummary(row: ActivityRow): React.ReactNode {
  if (row.action !== "memory.update") return null;
  const p = row.payload ?? {};
  const scope = p.scope as { from: string; to: string } | undefined;
  const projectKey = p.projectKey as { from: string | null; to: string | null } | undefined;
  if (!scope && !projectKey) return null;
  return (
    <div className="text-xs text-fg-subtle mt-1">
      {scope ? (
        <span>
          scope: {scope.from} → {scope.to}
        </span>
      ) : null}
      {scope && projectKey ? <span> · </span> : null}
      {projectKey ? (
        <span>
          project: {projectKey.from ?? "—"} → {projectKey.to ?? "—"}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Tiny relative-time formatter — no third-party dep needed for a few
 * grain buckets. Anything older than a week falls back to a date.
 */
function formatRelative(d: Date): string {
  const now = Date.now();
  const t = d.getTime();
  const diff = Math.max(0, now - t);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return d.toLocaleDateString();
}
