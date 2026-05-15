import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/lib/db/client";
import { projects } from "@/lib/db/schema";
import { createMemoryAction } from "@/lib/memory-actions";
import { Container, PageHeader } from "@/app/_components/ui/container";
import { Card, CardBody } from "@/app/_components/ui/card";
import { Input, Textarea, Label } from "@/app/_components/ui/input";
import { Button } from "@/app/_components/ui/button";

export const dynamic = "force-dynamic";

export default async function NewMemoryPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string; scope?: string }>;
}) {
  const session = await auth();
  const userId = session!.user.id;
  const params = await searchParams;
  const initialProject = params.project ?? "";
  const initialScope = params.scope === "user" ? "user" : "project";

  const projectList = await db
    .select({ key: projects.key, displayName: projects.displayName })
    .from(projects)
    .where(eq(projects.userId, userId))
    .orderBy(desc(projects.updatedAt))
    .limit(50);

  return (
    <Container className="pt-6 max-w-2xl">
      <PageHeader
        title="New memory"
        description="Pick a scope, write content, optionally add tags."
      />

      <Card>
        <CardBody>
          <form action={createMemoryAction} className="space-y-4">
            <div>
              <Label htmlFor="scope">Scope</Label>
              <select
                id="scope"
                name="scope"
                defaultValue={initialScope}
                className="mt-1 h-9 px-2 rounded-md bg-surface-1 border border-border text-fg text-sm w-full"
              >
                <option value="project">Project — attached to a project</option>
                <option value="user">User — global across all projects</option>
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
              <Label htmlFor="content">Content</Label>
              <Textarea
                id="content"
                name="content"
                required
                rows={10}
                placeholder="What should the next session know?"
                className="mt-1"
              />
            </div>

            <div>
              <Label htmlFor="tags" hint="comma- or space-separated">
                Tags
              </Label>
              <Input id="tags" name="tags" placeholder="auth, deployment, …" className="mt-1" />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Link href="/memories" className="no-underline">
                <Button type="button" variant="secondary">Cancel</Button>
              </Link>
              <Button type="submit">Save memory</Button>
            </div>
          </form>
        </CardBody>
      </Card>
    </Container>
  );
}
