"use client";

import { useActionState } from "react";
import { Button } from "@/app/_components/ui/button";
import { Input, Label } from "@/app/_components/ui/input";

interface State {
  token: string | null;
  error: string | null;
}

interface Props {
  action: (prev: State, formData: FormData) => Promise<State>;
  ttlDays: number;
}

const initial: State = { token: null, error: null };

export default function TokensManager({ action, ttlDays }: Props) {
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
          <pre className="mt-2">{`claude mcp add --transport http --scope user \\
  --header "Authorization: Bearer ${state.token}" \\
  shared-memory https://memory.dnspegasus.net/api/mcp`}</pre>
        </details>
        <p className="text-xs text-fg-subtle">
          Valid for {ttlDays} days. Revoke individually below if it leaks.
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
      <Button type="submit" disabled={pending}>
        {pending ? "Generating…" : "Generate token"}
      </Button>
      {state.error ? (
        <p className="basis-full text-sm text-danger">error: {state.error}</p>
      ) : null}
    </form>
  );
}
