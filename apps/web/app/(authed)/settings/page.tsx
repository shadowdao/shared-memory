import Link from "next/link";
import { eq } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import { Container, PageHeader } from "@/app/_components/ui/container";
import { Card, CardBody, CardHeader } from "@/app/_components/ui/card";
import { Button } from "@/app/_components/ui/button";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const session = await auth();
  const userId = session!.user.id;

  const userRow = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const user = userRow[0];

  return (
    <Container className="pt-6 max-w-3xl">
      <PageHeader title="Settings" />

      <div className="space-y-6">
        <Card>
          <CardHeader className="text-sm font-medium text-fg">Profile</CardHeader>
          <CardBody className="space-y-2 text-sm">
            <Field label="Name" value={user?.name} />
            <Field label="Email" value={user?.email} />
            <Field label="Internal user id" value={user?.id} mono />
            <Field label="OIDC issuer" value={user?.oidcIss} mono />
            <Field label="OIDC sub" value={user?.oidcSub} mono />
            <Field
              label="Joined"
              value={user?.createdAt ? new Date(user.createdAt).toLocaleString() : null}
            />
          </CardBody>
        </Card>

        <Card>
          <CardHeader className="flex items-center">
            <span className="text-sm font-medium text-fg flex-1">CLI tokens</span>
            <Link href="/settings/tokens" className="no-underline">
              <Button variant="secondary" size="sm">Manage tokens</Button>
            </Link>
          </CardHeader>
          <CardBody className="text-sm text-fg-muted">
            Bearer tokens for headless/automated MCP clients. Visit{" "}
            <Link href="/settings/tokens">/settings/tokens</Link> to generate
            and revoke them.
          </CardBody>
        </Card>

        <Card>
          <CardHeader className="flex items-center">
            <span className="text-sm font-medium text-fg flex-1">Groups</span>
            <Link href="/settings/groups" className="no-underline">
              <Button variant="secondary" size="sm">View groups</Button>
            </Link>
          </CardHeader>
          <CardBody className="text-sm text-fg-muted">
            OIDC group memberships from your IdP, refreshed at sign-in. Used
            by the upcoming sharing feature to scope project visibility.
          </CardBody>
        </Card>
      </div>
    </Container>
  );
}

function Field({
  label,
  value,
  mono,
}: {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="text-fg-muted w-36 shrink-0">{label}</span>
      <span className={`${mono ? "font-mono text-xs" : "text-sm"} text-fg break-all`}>
        {value ?? <span className="text-fg-subtle">—</span>}
      </span>
    </div>
  );
}
