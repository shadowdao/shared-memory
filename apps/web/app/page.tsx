import Link from "next/link";
import { auth } from "@/auth";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const session = await auth();

  return (
    <main className="container">
      <h1>shared-memory</h1>
      <p className="muted">
        Self-hosted MCP server providing shared persistent memory across Claude Code sessions.
      </p>

      {session?.user ? (
        <p>
          Signed in as <strong>{session.user.email ?? session.user.name ?? session.user.id}</strong>{" "}
          — <Link href="/me">view session</Link>
        </p>
      ) : (
        <p>
          <Link href="/api/auth/signin">Sign in with Authentik</Link>
        </p>
      )}

      <hr style={{ borderColor: "var(--border)", margin: "2rem 0" }} />
      <h2>MCP endpoint</h2>
      <p className="muted">
        Connect a Claude Code session to <code>/api/mcp</code> with a bearer token
        issued by Authentik for this resource. See the README for setup steps.
      </p>
    </main>
  );
}
