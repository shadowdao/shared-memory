import Link from "next/link";
import CopyButton from "./copy-button";

export const dynamic = "force-dynamic";

/**
 * /auth/cli-callback — OAuth redirect target for clients that can't open a
 * loopback port (e.g. Claude Code in a sealed container).
 *
 * The page is intentionally unauthenticated: the user arrives here as part
 * of an in-progress OAuth flow, before any session exists. The code is
 * single-use and proof of possession (PKCE on the client side) is still
 * required to exchange it. Showing it on this page does NOT grant access
 * by itself.
 */

interface SearchParams {
  code?: string;
  state?: string;
  error?: string;
  error_description?: string;
  iss?: string;
}

export default async function CliCallbackPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;

  if (params.error) {
    return (
      <main className="container">
        <h1 style={{ color: "#ff6b6b" }}>Sign-in failed</h1>
        <p>
          <code>{params.error}</code>
          {params.error_description ? <> — {params.error_description}</> : null}
        </p>
        <p className="muted">
          Switch back to your terminal, cancel the in-progress prompt, and
          retry the <code>claude mcp add</code> command. If the error
          persists, check that the redirect URI matches what your OIDC
          provider has registered.
        </p>
        <p>
          <Link href="/">← home</Link>
        </p>
      </main>
    );
  }

  if (!params.code) {
    return (
      <main className="container">
        <h1>OAuth callback</h1>
        <p className="muted">
          This page is the manual-fallback redirect target for the
          shared-memory MCP server. It only does something useful in the
          middle of an OAuth sign-in flow that couldn&apos;t reach a
          loopback callback on your machine.
        </p>
        <p>
          If you&apos;re trying to connect an MCP client, start over from
          your terminal with the <code>claude mcp add</code> command shown
          in the README.
        </p>
        <p>
          <Link href="/">← home</Link>
        </p>
      </main>
    );
  }

  const fullUrl = `?code=${encodeURIComponent(params.code)}${
    params.state ? `&state=${encodeURIComponent(params.state)}` : ""
  }${params.iss ? `&iss=${encodeURIComponent(params.iss)}` : ""}`;

  return (
    <main className="container">
      <h1 style={{ color: "#7ee787" }}>Sign-in complete</h1>
      <p>
        Switch back to your terminal where Claude Code (or whichever MCP
        client) is waiting, and paste one of the values below.
      </p>

      <h2>Authorization code</h2>
      <p className="muted">
        Most clients ask for just the <code>code</code>:
      </p>
      <CopyButton value={params.code} label="Copy code" />
      <pre
        style={{
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
          userSelect: "all",
        }}
      >
        {params.code}
      </pre>

      <h2 style={{ marginTop: "2rem" }}>Full callback URL</h2>
      <p className="muted">
        Some clients ask you to paste the entire URL their loopback timed
        out on:
      </p>
      <CopyButton value={fullUrl} label="Copy URL" />
      <pre
        style={{
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
          userSelect: "all",
        }}
      >
        {fullUrl}
      </pre>

      {params.state ? (
        <>
          <h3 style={{ marginTop: "2rem" }}>State (verification)</h3>
          <p className="muted">
            Your terminal client may show its expected state; it should
            match this value. If it doesn&apos;t, stop and start over —
            something is wrong with the flow.
          </p>
          <pre style={{ userSelect: "all" }}>{params.state}</pre>
        </>
      ) : null}

      <p className="muted" style={{ marginTop: "2rem" }}>
        The code is single-use and expires in a few minutes. If you take
        too long, retry the <code>claude mcp add</code> command.
      </p>
    </main>
  );
}
