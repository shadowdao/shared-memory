"use client";

import { useActionState } from "react";

interface State {
  token: string | null;
  error: string | null;
}

interface Props {
  action: (prev: State) => Promise<State>;
  ttlDays: number;
}

const initial: State = { token: null, error: null };

export default function ConnectForm({ action, ttlDays }: Props) {
  const [state, formAction, pending] = useActionState(action, initial);

  return (
    <section style={{ marginTop: "2rem" }}>
      {state.token ? (
        <>
          <h2 style={{ color: "#7ee787" }}>
            New token (copy now — won&apos;t be shown again)
          </h2>
          <pre
            style={{
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
              userSelect: "all",
            }}
          >
            {state.token}
          </pre>
          <h3>Add to Claude Code</h3>
          <pre>{`claude mcp add --transport http \\
  --header "Authorization: Bearer ${state.token}" \\
  shared-memory https://memory.dnspegasus.net/api/mcp`}</pre>
          <p className="muted">
            Valid for {ttlDays} days. To revoke all outstanding CLI tokens at
            once, rotate <code>CLI_TOKEN_SECRET</code> on the server.
          </p>
        </>
      ) : (
        <form action={formAction}>
          <button type="submit" disabled={pending}>
            {pending ? "Generating…" : "Generate token"}
          </button>
          {state.error ? (
            <p style={{ color: "#ff6b6b" }}>error: {state.error}</p>
          ) : null}
          <p className="muted" style={{ marginTop: "0.75rem" }}>
            Tokens carry your full Authentik identity. Valid for {ttlDays}{" "}
            days. Treat them like a password.
          </p>
        </form>
      )}
    </section>
  );
}
