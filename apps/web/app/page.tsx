import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { Button } from "@/app/_components/ui/button";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const session = await auth();
  // Signed-in users always go to the app; the landing is for anonymous
  // visitors only.
  if (session?.user) redirect("/dashboard");

  return (
    <main className="min-h-screen flex items-center justify-center px-4">
      <div className="max-w-xl w-full text-center space-y-6">
        <div className="inline-flex items-center gap-2 text-fg-muted text-sm">
          <span className="inline-block size-2 rounded-full bg-accent-400" />
          shared-memory
        </div>

        <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight text-fg">
          Shared, persistent memory<br />for every Claude Code session.
        </h1>

        <p className="text-fg-muted max-w-md mx-auto">
          A self-hosted MCP server that lets the Claude Codes on your laptop,
          server, and any container share durable memories, scoped per
          project or globally.
        </p>

        <div className="flex justify-center gap-3 pt-2">
          <Link href="/api/auth/signin?callbackUrl=/dashboard" className="no-underline">
            <Button>Sign in with OIDC</Button>
          </Link>
          <a
            href="https://repo.anhonesthost.net/jknapp/shared-memory"
            className="no-underline"
            target="_blank"
            rel="noreferrer"
          >
            <Button variant="secondary">Source</Button>
          </a>
        </div>

        <p className="text-xs text-fg-subtle pt-6">
          MCP endpoint at <code>/api/mcp</code> · OAuth discovery at{" "}
          <code>/.well-known/oauth-protected-resource</code>
        </p>
      </div>
    </main>
  );
}
