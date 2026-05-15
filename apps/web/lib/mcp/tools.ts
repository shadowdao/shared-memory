import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { memories, projects, auditLog } from "@/lib/db/schema";
import {
  MemoryIdInput,
  MemoryListInput,
  MemoryWriteInput,
  ProjectIdentifyInput,
} from "@shared-memory/schemas";
import type { UserContext } from "./context";

/**
 * MCP tool definitions for v1 (Phase 1). Each tool has:
 *   - name: dotted identifier exposed to clients
 *   - description: shown to the model
 *   - inputSchema: JSON Schema for the arguments object
 *   - handler: async function that runs the tool
 *
 * Search (memory.search) and snippets come in later phases.
 */

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  structuredContent?: unknown;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: unknown, ctx: UserContext) => Promise<ToolResult>;
}

// ---------- helpers ----------

function ok(structured: unknown, summary: string): ToolResult {
  return {
    content: [{ type: "text", text: summary }],
    structuredContent: structured,
  };
}

function err(message: string): ToolResult {
  return {
    content: [{ type: "text", text: `error: ${message}` }],
    isError: true,
  };
}

async function resolveProjectId(
  ctx: UserContext,
  projectKey: string | undefined,
): Promise<string | null> {
  if (!projectKey) return null;
  const row = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.userId, ctx.userId), eq(projects.key, projectKey)))
    .limit(1);
  return row[0]?.id ?? null;
}

// ---------- tools ----------

const projectIdentify: ToolDef = {
  name: "project.identify",
  description:
    "Register or look up a project for this user by its stable key. Returns the project's internal ID and display name. Call once per session before writing project-scoped memories.",
  inputSchema: {
    type: "object",
    properties: {
      key: {
        type: "string",
        description:
          "Stable project identifier. Recommended: repo name, repo URL, or any string the caller can reproduce across sessions.",
      },
      display_name: {
        type: "string",
        description: "Human-readable name shown in the Web UI. Optional.",
      },
    },
    required: ["key"],
  },
  async handler(args, ctx) {
    const parsed = ProjectIdentifyInput.safeParse(args);
    if (!parsed.success) return err(parsed.error.message);

    const row = await db
      .insert(projects)
      .values({
        userId: ctx.userId,
        key: parsed.data.key,
        displayName: parsed.data.display_name ?? null,
      })
      .onConflictDoUpdate({
        target: [projects.userId, projects.key],
        set: {
          displayName: parsed.data.display_name ?? sql`${projects.displayName}`,
          updatedAt: new Date(),
        },
      })
      .returning({
        id: projects.id,
        key: projects.key,
        displayName: projects.displayName,
        createdAt: projects.createdAt,
      });

    const p = row[0]!;
    return ok(p, `project ${p.key} (${p.id})`);
  },
};

const memoryWrite: ToolDef = {
  name: "memory.write",
  description:
    "Persist a memory for this user. With scope='project' (default), the memory is attached to the named project. With scope='user', it's a user-global memory shared across all projects.",
  inputSchema: {
    type: "object",
    properties: {
      content: { type: "string", description: "Memory content (1–64,000 chars)." },
      project: {
        type: "string",
        description: "Project key (required when scope='project').",
      },
      scope: {
        type: "string",
        enum: ["project", "user"],
        description: "Scope of the memory. Defaults to 'project'.",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Optional tags for filtering/grouping.",
      },
    },
    required: ["content"],
  },
  async handler(args, ctx) {
    const parsed = MemoryWriteInput.safeParse(args);
    if (!parsed.success) return err(parsed.error.message);

    const scope = parsed.data.scope;
    let projectId: string | null = null;
    if (scope === "project") {
      if (!parsed.data.project) return err("scope=project requires `project` key");
      projectId = await resolveProjectId(ctx, parsed.data.project);
      if (!projectId) {
        return err(`unknown project '${parsed.data.project}'; call project.identify first`);
      }
    }

    const inserted = await db
      .insert(memories)
      .values({
        userId: ctx.userId,
        projectId,
        scope,
        content: parsed.data.content,
        tags: parsed.data.tags ?? [],
      })
      .returning({ id: memories.id, createdAt: memories.createdAt });

    const m = inserted[0]!;
    await db.insert(auditLog).values({
      userId: ctx.userId,
      actor: "mcp",
      action: "memory.write",
      entityType: "memory",
      entityId: m.id,
      payload: { scope, projectKey: parsed.data.project ?? null, tags: parsed.data.tags ?? [] },
    });

    return ok({ id: m.id, createdAt: m.createdAt }, `wrote memory ${m.id}`);
  },
};

const memoryList: ToolDef = {
  name: "memory.list",
  description:
    "List memories for this user, most recent first. Filter by project key and/or scope. Phase 2 will add memory.search for semantic + full-text lookup.",
  inputSchema: {
    type: "object",
    properties: {
      project: { type: "string", description: "Filter by project key." },
      scope: { type: "string", enum: ["project", "user"], description: "Filter by scope." },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Require all of these tags.",
      },
      limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
    },
  },
  async handler(args, ctx) {
    const parsed = MemoryListInput.safeParse(args);
    if (!parsed.success) return err(parsed.error.message);

    const where = [eq(memories.userId, ctx.userId), isNull(memories.deletedAt)];

    if (parsed.data.scope) where.push(eq(memories.scope, parsed.data.scope));

    if (parsed.data.project) {
      const projectId = await resolveProjectId(ctx, parsed.data.project);
      if (!projectId) return ok({ items: [], next_cursor: null }, "0 results");
      where.push(eq(memories.projectId, projectId));
    }

    if (parsed.data.tags && parsed.data.tags.length > 0) {
      where.push(sql`${memories.tags} @> ${parsed.data.tags}::text[]`);
    }

    const rows = await db
      .select({
        id: memories.id,
        scope: memories.scope,
        projectId: memories.projectId,
        content: memories.content,
        tags: memories.tags,
        createdAt: memories.createdAt,
        updatedAt: memories.updatedAt,
      })
      .from(memories)
      .where(and(...where))
      .orderBy(desc(memories.createdAt))
      .limit(parsed.data.limit);

    return ok({ items: rows, next_cursor: null }, `${rows.length} result(s)`);
  },
};

const memoryGet: ToolDef = {
  name: "memory.get",
  description: "Fetch a single memory by its UUID.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string", format: "uuid" } },
    required: ["id"],
  },
  async handler(args, ctx) {
    const parsed = MemoryIdInput.safeParse(args);
    if (!parsed.success) return err(parsed.error.message);

    const row = await db
      .select()
      .from(memories)
      .where(
        and(
          eq(memories.id, parsed.data.id),
          eq(memories.userId, ctx.userId),
          isNull(memories.deletedAt),
        ),
      )
      .limit(1);

    if (!row[0]) return err("not found");
    return ok(row[0], `memory ${row[0].id}`);
  },
};

const memoryDelete: ToolDef = {
  name: "memory.delete",
  description: "Soft-delete a memory (sets deleted_at; preserved for audit).",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string", format: "uuid" } },
    required: ["id"],
  },
  async handler(args, ctx) {
    const parsed = MemoryIdInput.safeParse(args);
    if (!parsed.success) return err(parsed.error.message);

    const updated = await db
      .update(memories)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(memories.id, parsed.data.id),
          eq(memories.userId, ctx.userId),
          isNull(memories.deletedAt),
        ),
      )
      .returning({ id: memories.id });

    if (!updated[0]) return err("not found");

    await db.insert(auditLog).values({
      userId: ctx.userId,
      actor: "mcp",
      action: "memory.delete",
      entityType: "memory",
      entityId: updated[0].id,
    });

    return ok({ id: updated[0].id, deleted: true }, `deleted memory ${updated[0].id}`);
  },
};

export const tools: ToolDef[] = [
  projectIdentify,
  memoryWrite,
  memoryList,
  memoryGet,
  memoryDelete,
];

export const toolMap: Record<string, ToolDef> = Object.fromEntries(
  tools.map((t) => [t.name, t]),
);
