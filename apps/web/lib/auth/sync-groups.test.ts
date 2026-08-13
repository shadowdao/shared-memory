import { afterAll, beforeEach, describe, expect, test } from "vitest";

/**
 * Group sync, and specifically the overage case.
 *
 * `syncUserGroupsFromClaim` deletes every membership when it sees no groups.
 * That is correct for "the IdP says zero groups" and catastrophic for "the
 * IdP declined to enumerate them" — EntraID past 200 groups. The two look
 * identical if you only inspect `claims.groups`, which is why the function
 * takes the whole claims object.
 */
const { db, pg } = await import("@/lib/db/client");
const { users, groups, userGroups } = await import("@/lib/db/schema");
const { syncUserGroupsFromClaim, detectGroupsOverage, GroupsOverageError } =
  await import("@/lib/auth/sync-groups");
const { eq } = await import("drizzle-orm");

const ISS = "https://login.microsoftonline.com/sync-test/v2.0";
let userId: string;

async function memberships(): Promise<string[]> {
  const rows = await db
    .select({ name: groups.name })
    .from(userGroups)
    .innerJoin(groups, eq(userGroups.groupId, groups.id))
    .where(eq(userGroups.userId, userId));
  return rows.map((r) => r.name).sort();
}

beforeEach(async () => {
  await db.delete(users).where(eq(users.oidcIss, ISS));
  await db.delete(groups).where(eq(groups.oidcIss, ISS));
  const rows = await db
    .insert(users)
    .values({ oidcIss: ISS, oidcSub: "sync-test-sub" })
    .returning({ id: users.id });
  const row = rows[0];
  if (!row) throw new Error("failed to seed test user");
  userId = row.id;
});

afterAll(async () => {
  await db.delete(users).where(eq(users.oidcIss, ISS));
  await db.delete(groups).where(eq(groups.oidcIss, ISS));
  await pg.end();
});

describe("detectGroupsOverage", () => {
  test("spots the JWT overage pointer", () => {
    expect(
      detectGroupsOverage({
        _claim_names: { groups: "src1" },
        _claim_sources: { src1: { endpoint: "https://graph.windows.net/x" } },
      }),
    ).toBe(true);
  });

  test("spots the implicit-flow indicator", () => {
    expect(detectGroupsOverage({ hasgroups: true })).toBe(true);
  });

  test("is false for ordinary claims", () => {
    expect(detectGroupsOverage({ groups: ["a"] })).toBe(false);
    expect(detectGroupsOverage({})).toBe(false);
    expect(detectGroupsOverage(null)).toBe(false);
    // A _claim_names for some OTHER claim is not a groups overage.
    expect(detectGroupsOverage({ _claim_names: { roles: "src1" } })).toBe(false);
    expect(detectGroupsOverage({ hasgroups: false })).toBe(false);
  });
});

describe("syncUserGroupsFromClaim", () => {
  test("stores the claim's names", async () => {
    await syncUserGroupsFromClaim(userId, ISS, { groups: ["eng", "ops"] });
    expect(await memberships()).toEqual(["eng", "ops"]);
  });

  test("an empty claim really does clear memberships", async () => {
    await syncUserGroupsFromClaim(userId, ISS, { groups: ["eng"] });
    await syncUserGroupsFromClaim(userId, ISS, { groups: [] });
    expect(await memberships()).toEqual([]);
  });

  test("an absent claim clears memberships", async () => {
    // Unchanged behaviour: the IdP has stopped asserting groups, so we stop
    // honouring them rather than keeping stale grants alive.
    await syncUserGroupsFromClaim(userId, ISS, { groups: ["eng"] });
    await syncUserGroupsFromClaim(userId, ISS, {});
    expect(await memberships()).toEqual([]);
  });

  test("overage throws instead of clearing", async () => {
    await syncUserGroupsFromClaim(userId, ISS, { groups: ["eng", "ops"] });

    await expect(
      syncUserGroupsFromClaim(userId, ISS, {
        _claim_names: { groups: "src1" },
        _claim_sources: { src1: { endpoint: "https://graph.windows.net/x" } },
      }),
    ).rejects.toBeInstanceOf(GroupsOverageError);

    // The whole point: the snapshot survives, so the operator can fix the IdP
    // and the user comes back with their access intact.
    expect(await memberships()).toEqual(["eng", "ops"]);
  });

  test("the overage error names the fix", async () => {
    let err: Error | null = null;
    try {
      await syncUserGroupsFromClaim(userId, ISS, { hasgroups: true });
    } catch (e) {
      err = e as Error;
    }

    expect(err).toBeInstanceOf(GroupsOverageError);
    expect(err?.message).toContain("groupMembershipClaims");
    expect(err?.message).toContain("ApplicationGroup");
  });

  test("non-string entries are dropped, names are de-duplicated", async () => {
    await syncUserGroupsFromClaim(userId, ISS, {
      groups: ["eng", 7, null, " eng ", "ops"],
    });
    expect(await memberships()).toEqual(["eng", "ops"]);
  });
});
