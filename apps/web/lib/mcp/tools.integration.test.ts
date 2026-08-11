import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Integration tests for memory.get and memory.patch against a REAL
 * Postgres (pgvector). See CONTRIBUTING/README for spinning up the test
 * database; without it these tests fail to connect rather than silently
 * passing.
 *
 * The embedder sidecar is the one thing stubbed — it's an external HTTP
 * service running an ML model. The stub is deterministic per-text, which
 * lets the re-embedding test assert on the STORED VECTOR CHANGING (real
 * DB state) rather than on "was the mock called".
 */
vi.mock("@/lib/embedder", () => ({
  embedText: async (text: string) => {
    // Deterministic pseudo-vector: distinct texts produce distinct vectors.
    let h = 0;
    for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
    return Array.from({ length: 384 }, (_, i) => ((h + i * 7919) % 1000) / 1000);
  },
  embedTexts: async (texts: string[]) => texts.map(() => Array(384).fill(0.1)),
  embedderReady: async () => true,
  EmbedderError: class extends Error {},
}));

const { db, pg } = await import("@/lib/db/client");
const { memories, projects, users } = await import("@/lib/db/schema");
const { toolMap } = await import("@/lib/mcp/tools");
const { eq } = await import("drizzle-orm");
type UserContext = import("@/lib/mcp/context").UserContext;

const ORIGINAL = [
  "# Roadmap",
  "",
  "## RECENTLY SHIPPED",
  "- v1.0 initial release",
  "",
  "## IN PROGRESS",
  "- patch primitive",
  "",
].join("\n");

let userId: string;
let projectId: string;
let memoryId: string;
let ctx: UserContext;

async function seedMemory(content = ORIGINAL): Promise<string> {
  const row = await db
    .insert(memories)
    .values({
      userId,
      projectId,
      scope: "project",
      content,
      tags: ["roadmap"],
      embedding: Array(384).fill(0.5),
    })
    .returning({ id: memories.id });
  return row[0]!.id;
}

async function readContent(id: string): Promise<string> {
  const r = await db
    .select({ content: memories.content })
    .from(memories)
    .where(eq(memories.id, id));
  return r[0]!.content;
}

beforeAll(async () => {
  const u = await db
    .insert(users)
    .values({ oidcSub: "test-sub", oidcIss: "http://test", email: "t@example.com" })
    .onConflictDoNothing()
    .returning({ id: users.id });
  userId =
    u[0]?.id ??
    (await db.select({ id: users.id }).from(users).limit(1))[0]!.id;

  const p = await db
    .insert(projects)
    .values({ userId, key: "test-project", displayName: "Test Project" })
    .onConflictDoNothing()
    .returning({ id: projects.id });
  projectId =
    p[0]?.id ??
    (await db.select({ id: projects.id }).from(projects).limit(1))[0]!.id;

  ctx = {
    userId,
    sub: "test-sub",
    iss: "http://test",
    email: null,
    name: null,
    groups: [],
  };
});

beforeEach(async () => {
  memoryId = await seedMemory();
});

afterAll(async () => {
  await db.delete(memories);
  await pg.end();
});

describe("memory.get response shape (P1)", () => {
  test("does not leak the embedding or the tsvector to the caller", async () => {
    const res = await toolMap["memory.get"]!.handler({ id: memoryId }, ctx);
    const fields = Object.keys(res.structuredContent as object);

    expect(fields).not.toContain("embedding");
    expect(fields).not.toContain("contentTsv");
  });

  test("returns exactly the same 9 fields as memory.list", async () => {
    const res = await toolMap["memory.get"]!.handler({ id: memoryId }, ctx);
    const fields = Object.keys(res.structuredContent as object).sort();

    expect(fields).toEqual(
      [
        "content",
        "createdAt",
        "id",
        "lastEditedBy",
        "projectId",
        "scope",
        "tags",
        "updatedAt",
        "version",
      ].sort(),
    );
  });

  test("still returns the full content", async () => {
    const res = await toolMap["memory.get"]!.handler({ id: memoryId }, ctx);
    expect((res.structuredContent as { content: string }).content).toBe(ORIGINAL);
  });
});

describe("memory.patch (P2)", () => {
  test("applies a unique patch and increments version by exactly 1", async () => {
    const before = await db
      .select({ version: memories.version })
      .from(memories)
      .where(eq(memories.id, memoryId));

    const res = await toolMap["memory.patch"]!.handler(
      {
        id: memoryId,
        old_string: "## RECENTLY SHIPPED",
        new_string: "## RECENTLY SHIPPED\n- v1.1 patch primitive",
      },
      ctx,
    );

    expect(res.isError).toBeFalsy();
    const after = res.structuredContent as { version: number };
    expect(after.version).toBe(before[0]!.version + 1);
    expect(await readContent(memoryId)).toContain("- v1.1 patch primitive");
    // The rest of the document survived.
    expect(await readContent(memoryId)).toContain("- v1.0 initial release");
    expect(await readContent(memoryId)).toContain("## IN PROGRESS");
  });

  test("refuses an absent old_string and leaves content byte-identical", async () => {
    const res = await toolMap["memory.patch"]!.handler(
      { id: memoryId, old_string: "## NOT PRESENT", new_string: "x" },
      ctx,
    );

    expect(res.isError).toBe(true);
    expect(await readContent(memoryId)).toBe(ORIGINAL);
  });

  test("refuses an ambiguous old_string, naming the count, leaving content unchanged", async () => {
    const id = await seedMemory("alpha\nalpha\nbeta\n");

    const res = await toolMap["memory.patch"]!.handler(
      { id, old_string: "alpha", new_string: "gamma" },
      ctx,
    );

    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/2/);
    expect(await readContent(id)).toBe("alpha\nalpha\nbeta\n");
  });

  test("refuses a stale version and leaves content unchanged", async () => {
    const current = await db
      .select({ version: memories.version })
      .from(memories)
      .where(eq(memories.id, memoryId));

    const res = await toolMap["memory.patch"]!.handler(
      {
        id: memoryId,
        old_string: "## IN PROGRESS",
        new_string: "## DONE",
        version: current[0]!.version + 99,
      },
      ctx,
    );

    expect(res.isError).toBe(true);
    expect(await readContent(memoryId)).toBe(ORIGINAL);
  });

  test("rejects a patch that would push content past the 64,000-char limit", async () => {
    const id = await seedMemory("A".repeat(63_950) + "ANCHOR");

    const res = await toolMap["memory.patch"]!.handler(
      { id, old_string: "ANCHOR", new_string: "B".repeat(100) },
      ctx,
    );

    expect(res.isError).toBe(true);
    expect(await readContent(id)).toBe("A".repeat(63_950) + "ANCHOR");
  });

  test("re-embeds: the stored vector changes after a patch", async () => {
    const before = await pg<{ embedding: string }[]>`
      SELECT embedding::text AS embedding FROM memories WHERE id = ${memoryId}
    `;

    await toolMap["memory.patch"]!.handler(
      { id: memoryId, old_string: "- patch primitive", new_string: "- shipped it" },
      ctx,
    );

    const after = await pg<{ embedding: string }[]>`
      SELECT embedding::text AS embedding FROM memories WHERE id = ${memoryId}
    `;

    expect(after[0]!.embedding).not.toBe(before[0]!.embedding);
  });

  test("full-text index updates itself, because content_tsv is a generated column", async () => {
    // This is the claim that a patch cannot rot FTS. Postgres maintains
    // content_tsv; only the embedding needs an explicit recompute.
    await toolMap["memory.patch"]!.handler(
      {
        id: memoryId,
        old_string: "- patch primitive",
        new_string: "- kumquat marmalade",
      },
      ctx,
    );

    const hit = await pg<{ n: number }[]>`
      SELECT count(*)::int AS n FROM memories
      WHERE id = ${memoryId} AND content_tsv @@ plainto_tsquery('english', 'kumquat')
    `;
    expect(hit[0]!.n).toBe(1);
  });
});
