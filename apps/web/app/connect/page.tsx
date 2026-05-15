import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import { mintCliToken, CLI_TOKEN_TTL_SECONDS } from "@/lib/auth/cli-token";
import ConnectForm from "./connect-form";

export const dynamic = "force-dynamic";

/**
 * Server action — mints a fresh CLI token for the currently signed-in user.
 *
 * Returned via useActionState to the client; the token only ever exists in
 * React state, never in the URL or a persisted cookie.
 */
async function generateToken(_prev: { token: string | null; error: string | null }) {
  "use server";
  try {
    const session = await auth();
    if (!session?.user?.id) return { token: null, error: "not authenticated" };

    const row = await db
      .select({
        oidcIss: users.oidcIss,
        oidcSub: users.oidcSub,
        email: users.email,
        name: users.name,
      })
      .from(users)
      .where(eq(users.id, session.user.id))
      .limit(1);
    const u = row[0];
    if (!u) return { token: null, error: "user row not found" };

    const token = await mintCliToken({
      oidcIss: u.oidcIss,
      oidcSub: u.oidcSub,
      email: u.email,
      name: u.name,
    });
    return { token, error: null };
  } catch (e) {
    return { token: null, error: e instanceof Error ? e.message : "unknown error" };
  }
}

export default async function ConnectPage() {
  const session = await auth();
  if (!session?.user) {
    redirect("/api/auth/signin?callbackUrl=/connect");
  }

  const ttlDays = Math.floor(CLI_TOKEN_TTL_SECONDS / 86400);
  const userLabel = session.user.email ?? session.user.name ?? session.user.id;

  return (
    <main className="container">
      <h1>Connect an MCP client</h1>
      <p className="muted">
        Generate a bearer token for pasting into Claude Code (or any MCP
        client) when an OAuth loopback callback isn&apos;t practical — for
        example, a Claude Code instance running inside a container.
      </p>

      <p>
        Signed in as <strong>{userLabel}</strong>.
      </p>

      <ConnectForm action={generateToken} ttlDays={ttlDays} />
    </main>
  );
}
