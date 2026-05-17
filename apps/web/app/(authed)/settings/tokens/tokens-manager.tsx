"use client";

import { useActionState } from "react";
import { Button } from "@/app/_components/ui/button";
import { Input, Label } from "@/app/_components/ui/input";

/**
 * State returned by the `createTokenAction` server action.
 *
 * `projectKey` is the project the user chose to pin the token to. It's NOT
 * baked into the JWT itself — the token remains identity-only — it just
 * lets us bake `--header "X-Project-Key: <key>"` into the generated
 * `claude mcp add` snippet so calls from this client default to that
 * project without the model having to pass it explicitly.
 */
export interface CreateTokenState {
  token: string | null;
  error: string | null;
  projectKey: string | null;
}

export interface ProjectOption {
  key: string;
  displayName: string | null;
}

interface Props {
  action: (prev: CreateTokenState, formData: FormData) => Promise<CreateTokenState>;
  ttlDays: number;
  projects: ProjectOption[];
}

const initial: CreateTokenState = { token: null, error: null, projectKey: null };

export default function TokensManager({ action, ttlDays, projects }: Props) {
  const [state, formAction, pending] = useActionState(action, initial);

  if (state.token) {
    return (
      <div className="space-y-3">
        <div className="text-sm text-success font-medium">
          Token generated — copy now, you won&apos;t see it again
        </div>
        <pre
          className="!whitespace-pre-wrap !break-all select-all"
          style={{ userSelect: "all" }}
        >
          {state.token}
        </pre>
        <details className="text-xs text-fg-muted">
          <summary className="cursor-pointer">claude mcp add command</summary>
          <pre className="mt-2">{buildMcpAddSnippet(state.token, state.projectKey)}</pre>
        </details>
        <p className="text-xs text-fg-subtle">
          Valid for {ttlDays} days. Revoke individually below if it leaks.
          {state.projectKey ? (
            <>
              {" "}This token is pinned to project{" "}
              <code className="font-mono">{state.projectKey}</code> via the{" "}
              <code className="font-mono">X-Project-Key</code> header in the
              snippet above — the JWT itself is identity-only.
            </>
          ) : null}
        </p>
      </div>
    );
  }

  return (
    <form action={formAction} className="flex flex-wrap items-end gap-3">
      <div className="flex-1 min-w-[200px]">
        <Label htmlFor="name" hint="optional">Token name</Label>
        <Input
          id="name"
          name="name"
          placeholder="e.g. Laptop, Headless CI, …"
          className="mt-1"
          autoComplete="off"
        />
      </div>
      <div className="flex-1 min-w-[200px]">
        <Label htmlFor="projectKey" hint="optional">Pin to project</Label>
        <ProjectSelect projects={projects} />
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? "Generating…" : "Generate token"}
      </Button>
      {state.error ? (
        <p className="basis-full text-sm text-danger">error: {state.error}</p>
      ) : null}
    </form>
  );
}

function ProjectSelect({ projects }: { projects: ProjectOption[] }) {
  // Match Input styling — Tailwind v4 classes from `lib/ui/input.tsx`.
  const cls =
    "mt-1 block w-full h-9 px-3 text-sm rounded-md bg-surface-1 " +
    "border border-border text-fg focus:border-accent-400 focus:outline-none " +
    "disabled:opacity-50 transition-colors";

  if (projects.length === 0) {
    return (
      <select id="projectKey" name="projectKey" className={cls} disabled>
        <option value="">No projects yet</option>
      </select>
    );
  }
  return (
    <select id="projectKey" name="projectKey" defaultValue="" className={cls}>
      <option value="">(none — token works across all projects)</option>
      {projects.map((p) => (
        <option key={p.key} value={p.key}>
          {p.displayName && p.displayName !== p.key
            ? `${p.key} — ${p.displayName}`
            : p.key}
        </option>
      ))}
    </select>
  );
}

function buildMcpAddSnippet(token: string, projectKey: string | null): string {
  const headerLines = [`  --header "Authorization: Bearer ${token}"`];
  if (projectKey) {
    headerLines.push(`  --header "X-Project-Key: ${projectKey}"`);
  }
  return [
    "claude mcp add --transport http --scope user \\",
    ...headerLines.map((l) => `${l} \\`),
    "  shared-memory https://memory.dnspegasus.net/api/mcp",
  ].join("\n");
}
