import { afterAll, beforeEach, describe, expect, test } from "vitest";

/**
 * Identity resolution across the two surfaces.
 *
 * The bug these guard against is silent: on EntraID the Web UI and the MCP
 * endpoint see different `sub` values for the same person, both code paths
 * UPSERT rather than fail, and the result is two accounts — the user signs in,
 * connects an MCP client, and finds their memories gone. Nothing errors, so
 * only a test that asserts "same person ⇒ same row id" catches it.
 */
const { db, pg } = await import("@/lib/db/client");
const { users } = await import("@/lib/db/schema");
const { resolveUserId, oidClaim } = await import("@/lib/auth/identity");
const { eq } = await import("drizzle-orm");

/** `noUncheckedIndexedAccess` is on; narrow once rather than at every use. */
function first<T>(rows: T[]): T {
  const row = rows[0];
  if (!row) throw new Error("expected at least one row");
  return row;
}

const ISS = "https://login.microsoftonline.com/test-tenant/v2.0";

/** Distinct `sub` values, as EntraID's pairwise identifiers would be. */
const WEB_SUB = "pairwise-sub-for-web-registration";
const MCP_SUB = "pairwise-sub-for-mcp-registration";
const OID = "00000000-1111-2222-3333-444444444444";

function claims(overrides: Record<string, unknown> = {}) {
  return {
    iss: ISS,
    sub: WEB_SUB,
    oid: OID,
    email: "person@example.com",
    name: "Person",
    picture: null,
    ...overrides,
  } as Parameters<typeof resolveUserId>[0];
}

beforeEach(async () => {
  await db.delete(users).where(eq(users.oidcIss, ISS));
});

afterAll(async () => {
  await db.delete(users).where(eq(users.oidcIss, ISS));
  await pg.end();
});

describe("oidClaim", () => {
  test("reads a string oid", () => {
    expect(oidClaim({ oid: OID })).toBe(OID);
  });

  test("is null when absent, blank, or not a string", () => {
    expect(oidClaim({})).toBeNull();
    expect(oidClaim({ oid: "   " })).toBeNull();
    expect(oidClaim({ oid: 42 })).toBeNull();
    expect(oidClaim(null)).toBeNull();
  });
});

describe("resolveUserId with an oid (EntraID)", () => {
  test("both surfaces resolve to ONE row despite different subs", async () => {
    const fromWeb = await resolveUserId(claims({ sub: WEB_SUB }));
    const fromMcp = await resolveUserId(claims({ sub: MCP_SUB }));

    expect(fromMcp).toBe(fromWeb);

    const rows = await db.select().from(users).where(eq(users.oidcIss, ISS));
    expect(rows).toHaveLength(1);
  });

  test("does not rewrite oidc_sub once the row exists", async () => {
    await resolveUserId(claims({ sub: WEB_SUB }));
    await resolveUserId(claims({ sub: MCP_SUB }));

    const rows = await db.select().from(users).where(eq(users.oidcIss, ISS));
    // Whichever arrived first stays put; flip-flopping it on every request
    // could collide with the (iss, sub) unique index.
    expect(first(rows).oidcSub).toBe(WEB_SUB);
    expect(first(rows).oidcOid).toBe(OID);
  });

  test("adopts a pre-migration row instead of stranding it", async () => {
    // A deployment that signed this person in before 0005 ran: correct sub,
    // no oid recorded.
    const legacy = first(
      await db
        .insert(users)
        .values({ oidcIss: ISS, oidcSub: WEB_SUB, email: "old@example.com" })
        .returning({ id: users.id }),
    );

    const resolved = await resolveUserId(claims({ sub: WEB_SUB }));

    expect(resolved).toBe(legacy.id);
    const rows = await db.select().from(users).where(eq(users.oidcIss, ISS));
    expect(rows).toHaveLength(1);
    expect(first(rows).oidcOid).toBe(OID);
  });

  test("refreshes profile fields on an existing row", async () => {
    await resolveUserId(claims({ name: "Old Name" }));
    await resolveUserId(claims({ sub: MCP_SUB, name: "New Name" }));

    const rows = await db.select().from(users).where(eq(users.oidcIss, ISS));
    expect(first(rows).name).toBe("New Name");
  });

  test("concurrent first-contact from both surfaces yields one row", async () => {
    const [a, b] = await Promise.all([
      resolveUserId(claims({ sub: WEB_SUB })),
      resolveUserId(claims({ sub: MCP_SUB })),
    ]);

    expect(a).toBe(b);
    const rows = await db.select().from(users).where(eq(users.oidcIss, ISS));
    expect(rows).toHaveLength(1);
  });

  test("different people in one tenant stay separate", async () => {
    const one = await resolveUserId(claims());
    const two = await resolveUserId(
      claims({ sub: "other-sub", oid: "99999999-1111-2222-3333-444444444444" }),
    );

    expect(two).not.toBe(one);
    const rows = await db.select().from(users).where(eq(users.oidcIss, ISS));
    expect(rows).toHaveLength(2);
  });
});

describe("resolveUserId without an oid (Authentik and friends)", () => {
  test("keys on (iss, sub) exactly as before", async () => {
    const initial = await resolveUserId(claims({ oid: null }));
    const again = await resolveUserId(claims({ oid: null, name: "Renamed" }));

    expect(again).toBe(initial);
    const rows = await db.select().from(users).where(eq(users.oidcIss, ISS));
    expect(rows).toHaveLength(1);
    expect(first(rows).oidcOid).toBeNull();
    expect(first(rows).name).toBe("Renamed");
  });

  test("distinct subs are distinct people", async () => {
    await resolveUserId(claims({ oid: null, sub: "a" }));
    await resolveUserId(claims({ oid: null, sub: "b" }));

    const rows = await db.select().from(users).where(eq(users.oidcIss, ISS));
    expect(rows).toHaveLength(2);
  });

  test("several oid-less users coexist — the unique index is partial", async () => {
    // A non-partial unique index on (iss, oid) would allow exactly one NULL
    // pair and reject everyone after the first.
    for (const sub of ["u1", "u2", "u3"]) {
      await resolveUserId(claims({ oid: null, sub }));
    }
    const rows = await db.select().from(users).where(eq(users.oidcIss, ISS));
    expect(rows).toHaveLength(3);
  });
});
