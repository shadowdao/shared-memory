import Link from "next/link";
import { auth } from "@/auth";
import { listSnippets } from "@/lib/snippets";
import { Container, PageHeader } from "@/app/_components/ui/container";
import { Card, CardBody } from "@/app/_components/ui/card";
import { Badge } from "@/app/_components/ui/badge";
import { Button } from "@/app/_components/ui/button";
import { Input } from "@/app/_components/ui/input";
import { EmptyState } from "@/app/_components/ui/empty-state";

export const dynamic = "force-dynamic";

type Scope = "project" | "user";

function detailHref(name: string, scope: Scope, projectKey: string | null): string {
  const params = new URLSearchParams({ scope });
  if (scope === "project" && projectKey) params.set("project", projectKey);
  return `/snippets/${encodeURIComponent(name)}?${params.toString()}`;
}

export default async function SnippetsPage({
  searchParams,
}: {
  searchParams: Promise<{ scope?: string; project?: string; tag?: string }>;
}) {
  const session = await auth();
  const userId = session!.user.id;
  const params = await searchParams;
  const scope: Scope | undefined =
    params.scope === "user" || params.scope === "project" ? params.scope : undefined;
  const project = params.project?.trim() || undefined;
  const tag = params.tag?.trim() || undefined;

  const rows = await listSnippets(userId, {
    scope,
    projectKey: project,
    tags: tag ? [tag] : undefined,
    limit: 200,
  });

  return (
    <Container className="pt-6">
      <PageHeader
        title="Snippets"
        description={
          rows.length === 0
            ? "Named, reusable templates. Fetched by exact name, never searched."
            : `${rows.length} snippet${rows.length === 1 ? "" : "s"}, most recently updated first.`
        }
        actions={
          <Link href="/snippets/new" className="no-underline">
            <Button>New snippet</Button>
          </Link>
        }
      />

      <form method="GET" action="/snippets" className="mb-6 flex flex-wrap items-center gap-2">
        <FilterSelect
          name="scope"
          value={scope}
          options={["", "project", "user"]}
          placeholder="Any scope"
        />
        <Input
          name="project"
          placeholder="Project key…"
          defaultValue={project ?? ""}
          className="w-44"
        />
        <Input name="tag" placeholder="Tag…" defaultValue={tag ?? ""} className="w-32" />
        <Button type="submit" variant="secondary">
          Apply
        </Button>
      </form>

      {rows.length === 0 ? (
        <EmptyState
          title="No snippets yet"
          description="Create a snippet to save a template, format, or checklist you want to reuse. Snippets are fetched by exact name — pick something stable like 'pr-description-format' or 'commit-msg-rules'."
          action={
            <Link href="/snippets/new" className="no-underline">
              <Button>Create the first one</Button>
            </Link>
          }
        />
      ) : (
        <ul className="space-y-2">
          {rows.map((s) => (
            <li key={s.id}>
              <Link
                href={detailHref(s.name, s.scope, s.projectKey)}
                className="block no-underline"
              >
                <Card className="hover:border-border-strong transition-colors">
                  <CardBody className="space-y-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono text-sm text-fg">{s.name}</span>
                      <Badge tone={s.scope === "user" ? "accent" : "neutral"}>
                        {s.scope}
                      </Badge>
                      {s.projectKey ? (
                        <span className="font-mono text-xs text-fg-subtle">
                          · {s.projectKey}
                        </span>
                      ) : null}
                      <span className="ml-auto text-xs text-fg-subtle">
                        updated {new Date(s.updatedAt).toLocaleString()}
                      </span>
                    </div>
                    {s.description ? (
                      <p className="text-sm text-fg-muted line-clamp-2">{s.description}</p>
                    ) : (
                      <p className="text-sm text-fg-subtle line-clamp-2 font-mono">{s.body}</p>
                    )}
                    {s.tags.length ? (
                      <div className="flex gap-1 flex-wrap">
                        {s.tags.map((t) => (
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
