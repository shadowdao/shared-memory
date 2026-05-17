import { revalidatePath } from "next/cache";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/lib/db/client";
import { cliTokens, projects, users } from "@/lib/db/schema";
import {
  mintCliToken,
  revokeCliToken,
  CLI_TOKEN_TTL_SECONDS,
} from "@/lib/auth/cli-token";
import { ProjectKey } from "@shared-memory/schemas";
import { Container, PageHeader } from "@/app/_components/ui/container";
import { Card, CardBody, CardHeader } from "@/app/_components/ui/card";
import { Badge } from "@/app/_components/ui/badge";
import { EmptyState } from "@/app/_components/ui/empty-state";
import TokensManager, { type CreateTokenState } from "./tokens-manager";

export const dynamic = "force-dynamic";

async function createTokenAction(
  _prev: CreateTokenState,
  formData: FormData,
): Promise<CreateTokenState> {
  "use server";
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { token: null, error: "not authenticated", projectKey: null };
    }

    const name = String(formData.get("name") ?? "").trim() || `Token ${new Date().toISOString().slice(0, 10)}`;

    // Optional pin-to-project. The token JWT itself does NOT need a project
    // claim — pinning is purely a UX shortcut so the generated `claude mcp
    // add` snippet bakes in `X-Project-Key: <key>` and every call from
    // that client lands on the right project by default.
    const rawProject = String(formData.get("projectKey") ?? "").trim();
    let projectKey: string | null = null;
    if (rawProject.length > 0) {
      const parsed = ProjectKey.safeParse(rawProject);
      if (!parsed.success) {
        return {
          token: null,
          error: `invalid project key: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
          projectKey: null,
        };
      }
      // Cross-check the project belongs to this user (defense in depth —
      // the dropdown is built from the user's projects, but the form is
      // re-submittable so don't trust the value).
      const found = await db
        .select({ key: projects.key })
        .from(projects)
        .where(and(eq(projects.userId, session.user.id), eq(projects.key, parsed.data)))
        .limit(1);
      if (!found[0]) {
        return {
          token: null,
          error: `unknown project '${parsed.data}'`,
          projectKey: null,
        };
      }
      projectKey = found[0].key;
    }

    const userRow = await db
      .select({
        oidcIss: users.oidcIss,
        oidcSub: users.oidcSub,
        email: users.email,
        name: users.name,
      })
      .from(users)
      .where(eq(users.id, session.user.id))
      .limit(1);
    const u = userRow[0];
    if (!u) return { token: null, error: "user row not found", projectKey: null };

    const minted = await mintCliToken(
      {
        userId: session.user.id,
        oidcIss: u.oidcIss,
        oidcSub: u.oidcSub,
        email: u.email,
        name: u.name,
      },
      { tokenName: name },
    );

    revalidatePath("/settings/tokens");
    return { token: minted.token, error: null, projectKey };
  } catch (e) {
    return {
      token: null,
      error: e instanceof Error ? e.message : "unknown error",
      projectKey: null,
    };
  }
}

async function revokeTokenAction(formData: FormData) {
  "use server";
  const session = await auth();
  if (!session?.user?.id) throw new Error("not authenticated");
  const tokenId = String(formData.get("tokenId") ?? "");
  await revokeCliToken(session.user.id, tokenId);
  revalidatePath("/settings/tokens");
}

export default async function TokensPage() {
  const session = await auth();
  const userId = session!.user.id;

  const [tokens, projectRows] = await Promise.all([
    db
      .select({
        id: cliTokens.id,
        name: cliTokens.name,
        jti: cliTokens.jti,
        createdAt: cliTokens.createdAt,
        lastUsedAt: cliTokens.lastUsedAt,
        expiresAt: cliTokens.expiresAt,
        revokedAt: cliTokens.revokedAt,
      })
      .from(cliTokens)
      .where(eq(cliTokens.userId, userId))
      .orderBy(desc(cliTokens.createdAt)),
    db
      .select({
        key: projects.key,
        displayName: projects.displayName,
      })
      .from(projects)
      .where(eq(projects.userId, userId))
      .orderBy(asc(projects.key)),
  ]);

  const active = tokens.filter((t) => !t.revokedAt && t.expiresAt > new Date());
  const inactive = tokens.filter((t) => t.revokedAt || t.expiresAt <= new Date());
  const ttlDays = Math.floor(CLI_TOKEN_TTL_SECONDS / 86400);

  return (
    <Container className="pt-6 max-w-3xl">
      <PageHeader
        title="CLI tokens"
        description={`Long-lived bearer tokens for MCP clients without browser access. ${ttlDays}-day expiry per token.`}
      />

      <Card className="mb-6">
        <CardHeader className="text-sm font-medium text-fg">Generate a new token</CardHeader>
        <CardBody>
          <TokensManager
            action={createTokenAction}
            ttlDays={ttlDays}
            projects={projectRows.map((p) => ({
              key: p.key,
              displayName: p.displayName,
            }))}
          />
        </CardBody>
      </Card>

      <h2 className="text-sm font-medium text-fg-muted mt-8 mb-2">Active tokens</h2>
      {active.length === 0 ? (
        <EmptyState title="No active tokens" description="Generate one above to connect a headless client." />
      ) : (
        <Card>
          {active.map((t, i) => (
            <div
              key={t.id}
              className={`px-4 py-3 flex items-center gap-3 ${i > 0 ? "border-t border-border" : ""}`}
            >
              <div className="flex-1 min-w-0">
                <div className="text-sm text-fg truncate">{t.name}</div>
                <div className="text-xs text-fg-subtle">
                  Created {new Date(t.createdAt).toLocaleDateString()} ·{" "}
                  {t.lastUsedAt
                    ? `last used ${new Date(t.lastUsedAt).toLocaleString()}`
                    : "never used"}
                  {" · "}expires {new Date(t.expiresAt).toLocaleDateString()}
                </div>
              </div>
              <form action={revokeTokenAction}>
                <input type="hidden" name="tokenId" value={t.id} />
                <button
                  type="submit"
                  className="text-xs text-danger hover:underline"
                >
                  Revoke
                </button>
              </form>
            </div>
          ))}
        </Card>
      )}

      {inactive.length > 0 ? (
        <>
          <h2 className="text-sm font-medium text-fg-muted mt-8 mb-2">Revoked / expired</h2>
          <Card>
            {inactive.map((t, i) => (
              <div
                key={t.id}
                className={`px-4 py-3 flex items-center gap-3 ${i > 0 ? "border-t border-border" : ""}`}
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-fg-muted truncate">{t.name}</div>
                  <div className="text-xs text-fg-subtle">
                    {t.revokedAt
                      ? `Revoked ${new Date(t.revokedAt).toLocaleString()}`
                      : `Expired ${new Date(t.expiresAt).toLocaleString()}`}
                  </div>
                </div>
                <Badge tone="danger">{t.revokedAt ? "revoked" : "expired"}</Badge>
              </div>
            ))}
          </Card>
        </>
      ) : null}
    </Container>
  );
}
