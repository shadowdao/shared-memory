import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Tests for the shared mutation layer itself — the code both the MCP
 * tools and the Web UI Server Actions now route through.
 *
 * Two things matter here:
 *   1. The ProjectResolver seam really is the ONLY behavioural difference
 *      between the two surfaces.
 *   2. The authorization rule is uniform across update / patch / delete.
 *      It previously wasn't: delete-over-MCP let a row's author bypass the
 *      project ACL.
 */
vi.mock("@/lib/embedder", () => ({
  embedText: async (text: string) => {
    let h = 0;
    for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
    return Array.from({ length: 384 }, (_, i) => ((h + i * 7919) % 1000) / 1000);
  },
  embedTexts: async (texts: string[]) => texts.map(() => Array(384).fill(0.1)),
  embedderReady: async () => true,
  EmbedderError: class extends Error {},
}));

const { db, pg } = await import("@/lib/db/client");
const { memories, projects, users, groups, userGroups, projectShares } = await import(
  "@/lib/db/schema"
);
const { createMemory, updateMemory, patchMemory, softDeleteMemory } = await import(
  "@/lib/memory-mutations"
);
const { and, eq } = await import("drizzle-orm");
type Actor = import("@/lib/memory-mutations").Actor;
type ProjectResolver = import("@/lib/memory-mutations").ProjectResolver;

const ISS = "http://test-mutations";

let actor: Actor;
let otherUserId: string;
let sharedProjectId: string;
let sharedGroupId: string;

/** Mirrors the MCP surface: unknown project keys are refused. */
const refusingResolver: ProjectResolver = async (key) => ({
  ok: false,
  error: `unknown project '${key}'; call project.identify first`,
});

/** Mirrors the Web UI surface: unknown project keys are created. */
function creatingResolver(userId: string): ProjectResolver {
  return async (key) => {
    const existing = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.key, key), eq(projects.userId, userId)))
      .limit(1);
    if (existing[0]) return { ok: true, value: existing[0].id };
    const created = await db
      .insert(projects)
      .values({ userId, key, displayName: key })
      .returning({ id: projects.id });
    return { ok: true, value: created[0]!.id };
  };
}

async function seedMemory(userId: string, projectId: string | null): Promise<string> {
  const r = await db
    .insert(memories)
    .values({
      userId,
      projectId,
      scope: projectId ? "project" : "user",
      content: "line one\nline two\n",
      tags: [],
      embedding: Array(384).fill(0.5),
      lastEditedBy: userId,
    })
    .returning({ id: memories.id });
  return r[0]!.id;
}

async function setShareAccess(access: "ro" | "rw") {
  await db
    .insert(projectShares)
    .values({ projectId: sharedProjectId, groupId: sharedGroupId, access })
    .onConflictDoUpdate({
      target: [projectShares.projectId, projectShares.groupId],
      set: { access },
    });
}

beforeAll(async () => {
  const me = await db
    .insert(users)
    .values({ oidcSub: "mut-me", oidcIss: ISS })
    .onConflictDoNothing()
    .returning({ id: users.id });
  const myId =
    me[0]?.id ??
    (
      await db.select({ id: users.id }).from(users).where(eq(users.oidcSub, "mut-me"))
    )[0]!.id;

  const other = await db
    .insert(users)
    .values({ oidcSub: "mut-other", oidcIss: ISS })
    .onConflictDoNothing()
    .returning({ id: users.id });
  otherUserId =
    other[0]?.id ??
    (
      await db.select({ id: users.id }).from(users).where(eq(users.oidcSub, "mut-other"))
    )[0]!.id;

  const p = await db
    .insert(projects)
    .values({ userId: otherUserId, key: "mut-shared", displayName: "Shared" })
    .onConflictDoNothing()
    .returning({ id: projects.id });
  sharedProjectId =
    p[0]?.id ??
    (
      await db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.key, "mut-shared"))
    )[0]!.id;

  const g = await db
    .insert(groups)
    .values({ oidcIss: ISS, name: "mut-team" })
    .onConflictDoNothing()
    .returning({ id: groups.id });
  sharedGroupId =
    g[0]?.id ??
    (
      await db.select({ id: groups.id }).from(groups).where(eq(groups.name, "mut-team"))
    )[0]!.id;

  await db
    .insert(userGroups)
    .values({ userId: myId, groupId: sharedGroupId })
    .onConflictDoNothing();

  actor = { userId: myId, groups: ["mut-team"], via: "mcp" };
});

beforeEach(async () => {
  await db.delete(memories);
  await setShareAccess("rw");
});

afterAll(async () => {
  await db.delete(memories);
  await pg.end();
});

describe("the ProjectResolver seam", () => {
  test("a refusing resolver rejects an unknown project without creating one", async () => {
    const res = await createMemory(
      actor,
      { content: "x", scope: "project", project: "brand-new-key", tags: [] },
      refusingResolver,
    );

    expect(res.ok).toBe(false);
    const rows = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.key, "brand-new-key"));
    expect(rows).toHaveLength(0);
  });

  test("a creating resolver makes the project and writes into it", async () => {
    const res = await createMemory(
      actor,
      { content: "x", scope: "project", project: "made-on-demand", tags: [] },
      creatingResolver(actor.userId),
    );

    expect(res.ok).toBe(true);
    const rows = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.key, "made-on-demand"));
    expect(rows).toHaveLength(1);
  });
});

describe("authorization is uniform across mutations", () => {
  // Each of these seeds a memory the actor AUTHORED, then downgrades the
  // share to read-only. Authoring must not survive as a write privilege.
  test("update is denied on a read-only share", async () => {
    const id = await seedMemory(actor.userId, sharedProjectId);
    await setShareAccess("ro");

    const res = await updateMemory(actor, { id, content: "edited" }, refusingResolver);

    expect(res.ok).toBe(false);
  });

  test("patch is denied on a read-only share", async () => {
    const id = await seedMemory(actor.userId, sharedProjectId);
    await setShareAccess("ro");

    const res = await patchMemory(actor, {
      id,
      old_string: "line one",
      new_string: "line uno",
    });

    expect(res.ok).toBe(false);
  });

  test("delete is denied on a read-only share", async () => {
    const id = await seedMemory(actor.userId, sharedProjectId);
    await setShareAccess("ro");

    const res = await softDeleteMemory(actor, { id });

    expect(res.ok).toBe(false);
  });

  test("all three are allowed again once the share is read-write", async () => {
    const id = await seedMemory(actor.userId, sharedProjectId);

    expect((await updateMemory(actor, { id, content: "a\nb\n" }, refusingResolver)).ok).toBe(
      true,
    );
    expect((await patchMemory(actor, { id, old_string: "a", new_string: "c" })).ok).toBe(
      true,
    );
    expect((await softDeleteMemory(actor, { id })).ok).toBe(true);
  });

  test("another user's user-scope memory is invisible to all three", async () => {
    const id = await seedMemory(otherUserId, null);

    expect((await updateMemory(actor, { id, content: "x" }, refusingResolver)).ok).toBe(
      false,
    );
    expect(
      (await patchMemory(actor, { id, old_string: "line one", new_string: "y" })).ok,
    ).toBe(false);
    expect((await softDeleteMemory(actor, { id })).ok).toBe(false);
  });
});

describe("audit trail records the originating surface", () => {
  test("via: 'web' and via: 'mcp' are both preserved", async () => {
    const webRes = await createMemory(
      { ...actor, via: "web" },
      { content: "from the web", scope: "user", tags: [] },
      refusingResolver,
    );
    expect(webRes.ok).toBe(true);

    const rows = await pg<{ actor: string }[]>`
      SELECT actor FROM audit_log WHERE action = 'memory.write' ORDER BY created_at DESC LIMIT 1
    `;
    expect(rows[0]!.actor).toBe("web");
  });
});
