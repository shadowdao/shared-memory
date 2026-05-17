import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/lib/db/client";
import { snippets, projects, users } from "@/lib/db/schema";
import { updateSnippetAction, deleteSnippetAction } from "@/lib/snippet-actions";
import { getSnippet, type SnippetWithProjectKey } from "@/lib/snippets";
import { getProjectAccess, getUserGroupNames, readableProjectIds } from "@/lib/access";
import { Container, PageHeader } from "@/app/_components/ui/container";
import { Card, CardBody, CardHeader } from "@/app/_components/ui/card";
import { Input, Textarea, Label } from "@/app/_components/ui/input";
import { Button } from "@/app/_components/ui/button";
import { Badge } from "@/app/_components/ui/badge";

export const dynamic = "force-dynamic";

interface SiblingHit {
  scope: "project" | "user";
  projectKey: string | null;
}

/**
 * When a snippet name exists in more than one scope (e.g. a user-scope
 * default plus one or more project-scope variants), we need to either
 * disambiguate by query string or, if no hint is given, show a picker.
 *
 * Visibility widening: with sharing, the user may also see project-
 * scope snippets under shared projects. Match rows that the viewer can
 * read (own user-scope rows, or project-scope rows in an accessible
 * project).
 */
async function findAllMatches(
  userId: string,
  groupNames: string[],
  name: string,
): Promise<SiblingHit[]> {
  const accessibleProjectIds = await readableProjectIds(userId, groupNames);
  const visibility =
    accessibleProjectIds.length > 0
      ? or(
          and(eq(snippets.userId, userId), isNull(snippets.projectId)),
          inArray(snippets.projectId, accessibleProjectIds),
        )
      : and(eq(snippets.userId, userId), isNull(snippets.projectId));
  const rows = await db
    .select({
      scope: snippets.scope,
      projectKey: projects.key,
    })
    .from(snippets)
    .leftJoin(projects, eq(snippets.projectId, projects.id))
    .where(and(eq(snippets.name, name), isNull(snippets.deletedAt), visibility!));
  return rows as SiblingHit[];
}

export default async function SnippetDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ name: string }>;
  searchParams: Promise<{ scope?: string; project?: string; edit?: string }>;
}) {
  const session = await auth();
  const userId = session!.user.id;
  const groupNames = await getUserGroupNames(userId);
  const { name: rawName } = await params;
  const name = decodeURIComponent(rawName);
  const sp = await searchParams;
  const scope: "project" | "user" | undefined =
    sp.scope === "user" || sp.scope === "project" ? sp.scope : undefined;
  const project = sp.project?.trim() || undefined;
  const wantsEdit = sp.edit === "1";

  const siblings = await findAllMatches(userId, groupNames, name);
  if (siblings.length === 0) notFound();

  // If multiple matches and the user hasn't disambiguated, show a picker.
  if (!scope && siblings.length > 1) {
    return (
      <Container className="pt-6 max-w-3xl">
        <PageHeader
          title={name}
          description={`This name exists in ${siblings.length} scopes — pick one to view.`}
          actions={
            <Link href="/snippets" className="no-underline">
              <Button type="button" variant="secondary">
                Back
              </Button>
            </Link>
          }
        />
        <Card>
          {siblings.map((s, i) => {
            const params = new URLSearchParams({ scope: s.scope });
            if (s.scope === "project" && s.projectKey) {
              params.set("project", s.projectKey);
            }
            return (
              <Link
                key={`${s.scope}-${s.projectKey ?? ""}`}
                href={`/snippets/${encodeURIComponent(name)}?${params.toString()}`}
                className={`block px-4 py-3 hover:bg-surface-2 no-underline ${i > 0 ? "border-t border-border" : ""}`}
              >
                <div className="flex items-center gap-3">
                  <Badge tone={s.scope === "user" ? "accent" : "neutral"}>{s.scope}</Badge>
                  {s.projectKey ? (
                    <span className="font-mono text-sm text-fg">{s.projectKey}</span>
                  ) : (
                    <span className="text-sm text-fg-muted">applies everywhere</span>
                  )}
                </div>
              </Link>
            );
          })}
        </Card>
      </Container>
    );
  }

  const snippet: SnippetWithProjectKey | null = await getSnippet(userId, {
    name,
    scope,
    projectKey: project,
    groupNames,
  });

  if (!snippet) notFound();

  // Authorize: user-scope rows belong solely to their owner; project-
  // scope rows require rw on the project (or ownership) to edit.
  let canWrite: boolean;
  if (snippet.scope === "user") {
    canWrite = snippet.userId === userId;
  } else if (snippet.projectId) {
    const access = await getProjectAccess(userId, groupNames, snippet.projectId);
    canWrite = access === "owner" || access === "rw";
  } else {
    canWrite = false;
  }
  const isEditing = wantsEdit && canWrite;

  // Editor name for "Last edited by ..." footer.
  const editorRow = snippet.lastEditedBy
    ? await db
        .select({ name: users.name, email: users.email })
        .from(users)
        .where(eq(users.id, snippet.lastEditedBy))
        .limit(1)
    : [];
  const editorLabel = editorRow[0]
    ? editorRow[0].name ?? editorRow[0].email ?? "unknown"
    : null;

  return (
    <Container className="pt-6 max-w-3xl">
      <PageHeader
        title={isEditing ? `Edit ${snippet.name}` : snippet.name}
        description={
          <span className="font-mono text-xs text-fg-subtle">
            {snippet.scope}
            {snippet.projectKey ? ` · ${snippet.projectKey}` : ""}
          </span>
        }
        actions={
          <>
            <Link href="/snippets" className="no-underline">
              <Button type="button" variant="secondary">
                Back
              </Button>
            </Link>
            {!isEditing && canWrite ? (
              <Link
                href={`/snippets/${encodeURIComponent(snippet.name)}?${new URLSearchParams({
                  scope: snippet.scope,
                  ...(snippet.scope === "project" && snippet.projectKey
                    ? { project: snippet.projectKey }
                    : {}),
                  edit: "1",
                }).toString()}`}
                className="no-underline"
              >
                <Button>Edit</Button>
              </Link>
            ) : null}
          </>
        }
      />

      <Card className="mb-4">
        <CardHeader className="flex items-center gap-2 text-xs text-fg-muted flex-wrap">
          <Badge tone={snippet.scope === "user" ? "accent" : "neutral"}>{snippet.scope}</Badge>
          {snippet.projectKey ? <span className="font-mono">{snippet.projectKey}</span> : null}
          <span>· Created {new Date(snippet.createdAt).toLocaleString()}</span>
          {snippet.updatedAt.getTime() !== snippet.createdAt.getTime() ? (
            <span>· Updated {new Date(snippet.updatedAt).toLocaleString()}</span>
          ) : null}
          {editorLabel && snippet.lastEditedBy !== snippet.userId ? (
            <span className="text-fg-subtle">· Last edited by {editorLabel}</span>
          ) : null}
        </CardHeader>

        {isEditing ? (
          <CardBody>
            <form action={updateSnippetAction} className="space-y-4">
              <input type="hidden" name="name" value={snippet.name} />
              <input type="hidden" name="scope" value={snippet.scope} />
              <input type="hidden" name="version" value={snippet.version} />
              {snippet.scope === "project" && snippet.projectKey ? (
                <input type="hidden" name="project" value={snippet.projectKey} />
              ) : null}

              <div>
                <Label htmlFor="description" hint="Optional">
                  Description
                </Label>
                <Input
                  id="description"
                  name="description"
                  defaultValue={snippet.description ?? ""}
                  className="mt-1"
                />
              </div>

              <div>
                <Label htmlFor="body">Body</Label>
                <Textarea
                  id="body"
                  name="body"
                  required
                  rows={16}
                  defaultValue={snippet.body}
                  className="mt-1"
                />
              </div>

              <div>
                <Label htmlFor="tags" hint="comma- or space-separated">
                  Tags
                </Label>
                <Input
                  id="tags"
                  name="tags"
                  defaultValue={snippet.tags.join(", ")}
                  className="mt-1"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <Link
                  href={`/snippets/${encodeURIComponent(snippet.name)}?${new URLSearchParams({
                    scope: snippet.scope,
                    ...(snippet.scope === "project" && snippet.projectKey
                      ? { project: snippet.projectKey }
                      : {}),
                  }).toString()}`}
                  className="no-underline"
                >
                  <Button type="button" variant="secondary">
                    Cancel
                  </Button>
                </Link>
                <Button type="submit">Save changes</Button>
              </div>
            </form>
          </CardBody>
        ) : (
          <CardBody>
            {snippet.description ? (
              <p className="text-sm text-fg-muted mb-3">{snippet.description}</p>
            ) : null}
            <pre className="whitespace-pre-wrap break-words bg-transparent border-0 p-0 text-sm text-fg leading-relaxed font-mono">
              {snippet.body}
            </pre>
            {snippet.tags.length ? (
              <div className="flex gap-1 flex-wrap mt-4">
                {snippet.tags.map((t) => (
                  <Badge key={t}>{t}</Badge>
                ))}
              </div>
            ) : null}
          </CardBody>
        )}
      </Card>

      {!isEditing && canWrite ? (
        <form action={deleteSnippetAction} className="flex justify-end">
          <input type="hidden" name="name" value={snippet.name} />
          <input type="hidden" name="scope" value={snippet.scope} />
          <input type="hidden" name="version" value={snippet.version} />
          {snippet.scope === "project" && snippet.projectKey ? (
            <input type="hidden" name="project" value={snippet.projectKey} />
          ) : null}
          <Button type="submit" variant="danger" size="sm">
            Delete snippet
          </Button>
        </form>
      ) : null}
    </Container>
  );
}
