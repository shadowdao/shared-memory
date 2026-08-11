import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Integration cover for the memory MUTATION paths (write / update / delete)
 * against a real Postgres. These exist mainly as a safety net for the
 * shared-mutation refactor: the MCP tools and the Web UI Server Actions
 * used to reimplement the same authorize → CAS → re-embed → audit sequence
 * separately, and these assertions pin the behaviour that must survive
 * being pulled into one place.
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
const { toolMap } = await import("@/lib/mcp/tools");
const { eq } = await import("drizzle-orm");
type UserContext = import("@/lib/mcp/context").UserContext;

const ISS = "http://test";

let author: UserContext;
let projectOwnerId: string;
let ownProjectId: string;
let sharedProjectId: string;
let sharedGroupId: string;

function ctxFor(userId: string, sub: string, groupNames: string[] = []): UserContext {
  return { userId, sub, iss: ISS, email: null, name: null, groups: groupNames };
}

async function upsertUser(sub: string): Promise<string> {
  const r = await db
    .insert(users)
    .values({ oidcSub: sub, oidcIss: ISS })
    .onConflictDoUpdate({ target: [users.oidcIss, users.oidcSub], set: { oidcSub: sub } })
    .returning({ id: users.id });
  return r[0]!.id;
}

async function seedMemory(
  userId: string,
  projectId: string | null,
  content = "seed content",
): Promise<string> {
  const r = await db
    .insert(memories)
    .values({
      userId,
      projectId,
      scope: projectId ? "project" : "user",
      content,
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

async function isDeleted(id: string): Promise<boolean> {
  const r = await db
    .select({ deletedAt: memories.deletedAt })
    .from(memories)
    .where(eq(memories.id, id));
  return r[0]!.deletedAt !== null;
}

beforeAll(async () => {
  const authorId = await upsertUser("author-sub");
  projectOwnerId = await upsertUser("owner-sub");

  const own = await db
    .insert(projects)
    .values({ userId: authorId, key: "author-own", displayName: "Author Own" })
    .onConflictDoNothing()
    .returning({ id: projects.id });
  ownProjectId =
    own[0]?.id ??
    (
      await db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.key, "author-own"))
    )[0]!.id;

  const shared = await db
    .insert(projects)
    .values({ userId: projectOwnerId, key: "team-shared", displayName: "Team Shared" })
    .onConflictDoNothing()
    .returning({ id: projects.id });
  sharedProjectId =
    shared[0]?.id ??
    (
      await db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.key, "team-shared"))
    )[0]!.id;

  const g = await db
    .insert(groups)
    .values({ oidcIss: ISS, name: "team" })
    .onConflictDoNothing()
    .returning({ id: groups.id });
  sharedGroupId =
    g[0]?.id ??
    (await db.select({ id: groups.id }).from(groups).where(eq(groups.name, "team")))[0]!
      .id;

  await db
    .insert(userGroups)
    .values({ userId: authorId, groupId: sharedGroupId })
    .onConflictDoNothing();

  author = ctxFor(authorId, "author-sub", ["team"]);
});

beforeEach(async () => {
  await db.delete(memories);
  await setShareAccess("rw");
});

afterAll(async () => {
  await db.delete(memories);
  await pg.end();
});

describe("memory.write", () => {
  test("writes into a project the caller owns", async () => {
    const res = await toolMap["memory.write"]!.handler(
      { content: "hello", scope: "project", project: "author-own" },
      author,
    );
    expect(res.isError).toBeFalsy();
  });

  test("refuses an unknown project rather than creating one", async () => {
    const res = await toolMap["memory.write"]!.handler(
      { content: "hello", scope: "project", project: "does-not-exist" },
      author,
    );

    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/project\.identify/);
  });
});

describe("memory.update", () => {
  test("updates content and increments version", async () => {
    const id = await seedMemory(author.userId, ownProjectId);
    const before = await db
      .select({ version: memories.version })
      .from(memories)
      .where(eq(memories.id, id));

    const res = await toolMap["memory.update"]!.handler(
      { id, content: "revised content" },
      author,
    );

    expect(res.isError).toBeFalsy();
    expect((res.structuredContent as { version: number }).version).toBe(
      before[0]!.version + 1,
    );
  });

  test("refuses a stale version", async () => {
    const id = await seedMemory(author.userId, ownProjectId);

    const res = await toolMap["memory.update"]!.handler(
      { id, content: "revised", version: 99 },
      author,
    );

    expect(res.isError).toBe(true);
  });

  test("denies updating a memory in a project shared read-only", async () => {
    const id = await seedMemory(author.userId, sharedProjectId);
    await setShareAccess("ro");

    const res = await toolMap["memory.update"]!.handler(
      { id, content: "sneaky edit" },
      author,
    );

    expect(res.isError).toBe(true);
  });
});

describe("memory.delete authorization", () => {
  test("allows deleting a memory in a project shared read-write", async () => {
    const id = await seedMemory(author.userId, sharedProjectId);

    const res = await toolMap["memory.delete"]!.handler({ id }, author);

    expect(res.isError).toBeFalsy();
    expect(await isDeleted(id)).toBe(true);
  });

  test("denies deleting a memory in a project shared read-only, even to its author", async () => {
    // The realistic path here: the memory was written while the share was
    // rw, then an owner downgraded the group to ro. Authoring the row must
    // not grant a standing write privilege the project ACL has revoked —
    // memory.update already refuses this, and delete must agree.
    const id = await seedMemory(author.userId, sharedProjectId);
    await setShareAccess("ro");

    const res = await toolMap["memory.delete"]!.handler({ id }, author);

    expect(res.isError).toBe(true);
    expect(await isDeleted(id)).toBe(false);
  });

  test("denies deleting another user's user-scope memory", async () => {
    const id = await seedMemory(projectOwnerId, null);

    const res = await toolMap["memory.delete"]!.handler({ id }, author);

    expect(res.isError).toBe(true);
    expect(await isDeleted(id)).toBe(false);
  });
});
