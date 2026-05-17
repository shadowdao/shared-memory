import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/lib/db/client";
import { projects } from "@/lib/db/schema";
import { createSnippetAction } from "@/lib/snippet-actions";
import { Container, PageHeader } from "@/app/_components/ui/container";
import { Card, CardBody } from "@/app/_components/ui/card";
import { Input, Textarea, Label } from "@/app/_components/ui/input";
import { Button } from "@/app/_components/ui/button";

export const dynamic = "force-dynamic";

export default async function NewSnippetPage({
  searchParams,
}: {
  searchParams: Promise<{ scope?: string; project?: string; name?: string }>;
}) {
  const session = await auth();
  const userId = session!.user.id;
  const params = await searchParams;
  const initialScope = params.scope === "project" ? "project" : "user";
  const initialProject = params.project ?? "";
  const initialName = params.name ?? "";

  const projectList = await db
    .select({ key: projects.key, displayName: projects.displayName })
    .from(projects)
    .where(eq(projects.userId, userId))
    .orderBy(desc(projects.updatedAt))
    .limit(50);

  return (
    <Container className="pt-6 max-w-2xl">
      <PageHeader
        title="New snippet"
        description="Name it something stable — that name is the lookup key from now on."
      />

      <Card>
        <CardBody>
          <form action={createSnippetAction} className="space-y-4">
            <div>
              <Label htmlFor="name" hint="alphanumerics + ._-/">
                Name
              </Label>
              <Input
                id="name"
                name="name"
                required
                defaultValue={initialName}
                placeholder="pr-description-format"
                className="mt-1 font-mono"
              />
            </div>

            <div>
              <Label htmlFor="scope">Scope</Label>
              <select
                id="scope"
                name="scope"
                defaultValue={initialScope}
                className="mt-1 h-9 px-2 rounded-md bg-surface-1 border border-border text-fg text-sm w-full"
              >
                <option value="user">User — applies everywhere (default)</option>
                <option value="project">Project — tied to a specific repo</option>
              </select>
            </div>

            <div>
              <Label htmlFor="project" hint="Required for project scope">
                Project key
              </Label>
              <Input
                id="project"
                name="project"
                defaultValue={initialProject}
                placeholder="repo name, slug, or any stable string"
                list="project-list"
                className="mt-1"
              />
              {projectList.length > 0 ? (
                <datalist id="project-list">
                  {projectList.map((p) => (
                    <option key={p.key} value={p.key}>
                      {p.displayName ?? p.key}
                    </option>
                  ))}
                </datalist>
              ) : null}
            </div>

            <div>
              <Label htmlFor="description" hint="Optional">
                Description
              </Label>
              <Input
                id="description"
                name="description"
                placeholder="When should this template be used?"
                className="mt-1"
              />
            </div>

            <div>
              <Label htmlFor="body">Body</Label>
              <Textarea
                id="body"
                name="body"
                required
                rows={14}
                placeholder="The full template, format, or checklist…"
                className="mt-1"
              />
            </div>

            <div>
              <Label htmlFor="tags" hint="comma- or space-separated">
                Tags
              </Label>
              <Input id="tags" name="tags" placeholder="format, review, …" className="mt-1" />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Link href="/snippets" className="no-underline">
                <Button type="button" variant="secondary">
                  Cancel
                </Button>
              </Link>
              <Button type="submit">Save snippet</Button>
            </div>
          </form>
        </CardBody>
      </Card>
    </Container>
  );
}
