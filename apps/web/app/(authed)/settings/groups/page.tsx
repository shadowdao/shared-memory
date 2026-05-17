import Link from "next/link";
import { eq } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/lib/db/client";
import { groups, userGroups } from "@/lib/db/schema";
import { Container, PageHeader } from "@/app/_components/ui/container";
import { Card } from "@/app/_components/ui/card";
import { EmptyState } from "@/app/_components/ui/empty-state";

export const dynamic = "force-dynamic";

/**
 * Debug page showing the OIDC groups currently associated with the signed-in
 * user. The list is rewritten on every sign-in from the IdP's `groups`
 * claim (see `lib/auth/sync-groups.ts`), so this view is effectively a
 * snapshot of "what your IdP told us about you at last login".
 *
 * Mainly intended as a sanity check for the upcoming sharing feature —
 * if the user expects to see "platform" and doesn't, the IdP probably
 * isn't emitting the claim, and the empty state points them at the
 * README troubleshooting section.
 */
export default async function GroupsSettingsPage() {
  const session = await auth();
  const userId = session!.user.id;

  const rows = await db
    .select({
      id: groups.id,
      name: groups.name,
      oidcIss: groups.oidcIss,
      syncedAt: userGroups.syncedAt,
    })
    .from(userGroups)
    .innerJoin(groups, eq(userGroups.groupId, groups.id))
    .where(eq(userGroups.userId, userId))
    .orderBy(groups.name);

  return (
    <Container className="pt-6 max-w-3xl">
      <PageHeader
        title="Groups"
        description="OIDC groups your identity provider asserted for you at last sign-in. Used by the upcoming sharing feature to decide which projects you can see."
      />

      {rows.length === 0 ? (
        <EmptyState
          title="No groups yet"
          description="Your IdP isn't emitting a `groups` claim on the access token, or you're not a member of any groups. See the troubleshooting section in the project README for how to configure Authentik / EntraID / Keycloak to emit group memberships."
        />
      ) : (
        <Card>
          {rows.map((g, i) => (
            <div
              key={g.id}
              className={`px-4 py-3 ${i > 0 ? "border-t border-border" : ""}`}
            >
              <div className="flex items-baseline gap-3">
                <div className="font-mono text-sm text-fg flex-1 truncate">
                  {g.name}
                </div>
                <div className="text-xs text-fg-subtle whitespace-nowrap">
                  synced {new Date(g.syncedAt).toLocaleString()}
                </div>
              </div>
              <div className="text-xs text-fg-subtle font-mono mt-0.5 truncate">
                {g.oidcIss}
              </div>
            </div>
          ))}
        </Card>
      )}

      <p className="text-xs text-fg-subtle mt-6">
        Groups refresh on every sign-in. If something looks stale,{" "}
        <Link href="/api/auth/signout">sign out</Link> and sign back in.
      </p>
    </Container>
  );
}
