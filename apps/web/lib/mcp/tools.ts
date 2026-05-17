import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { memories, projects, auditLog } from "@/lib/db/schema";
import {
  MemoryIdInput,
  MemoryListInput,
  MemorySearchInput,
  MemoryUpdateInput,
  MemoryWriteInput,
  ProjectIdentifyInput,
} from "@shared-memory/schemas";
import { embedText } from "@/lib/embedder";
import { searchMemories } from "@/lib/memories";
import type { UserContext } from "./context";

/**
 * MCP tool definitions. Each tool has:
 *   - name: dotted identifier exposed to clients
 *   - description: shown to the model
 *   - inputSchema: JSON Schema for the arguments object
 *   - handler: async function that runs the tool
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
    "Call ONCE near the start of every session that has a project context — a repo you're working in, a service you're debugging, etc. — to register or look up that project so subsequent project-scoped memories attach correctly. Use a stable `key` you can reproduce next session (repo name, repo URL, or working directory basename). Skip if the work is purely scratch / not tied to a specific codebase.",
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
    "Save a durable fact, preference, or decision that ANY future Claude Code session on ANY of this user's machines should know. Call this when the user shares something that meets ALL of: (1) likely to matter beyond this conversation, (2) not derivable from reading current code/git, (3) would surprise a future you if forgotten. Examples: 'I use HAProxy at home' (user-scope), 'we chose Drizzle over Prisma because of bundle size' (project-scope), 'our prod DB is at db.example.com' (user-scope reference). Use scope='user' for facts about the human or their infra; scope='project' for facts tied to a specific codebase (always preceded by project.identify). Sensitive info (API keys, credentials, connection strings the user actively shares with you) IS appropriate to save here — this server is OIDC-gated and per-user; safer than writing to local container files. DO NOT use for: transient task state, this-session-only scratch notes, or container-specific facts (those belong in the built-in file-based memory at ~/.claude/.../memory/). Tags help retrieval.",
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

    // Embed inline so the new memory is searchable immediately. Slower
    // writes (~50–150 ms) are an acceptable price for that guarantee; if
    // embedder pressure ever forces an async path, only this section
    // needs to change.
    const embedding = await embedText(parsed.data.content);

    const inserted = await db
      .insert(memories)
      .values({
        userId: ctx.userId,
        projectId,
        scope,
        content: parsed.data.content,
        tags: parsed.data.tags ?? [],
        embedding,
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
    "Browse memories chronologically — useful at session start to load all relevant project context when there's no specific search query. Prefer memory.search when you have a specific question to answer; use list when you just want recent context. Filter by project, scope, or tags. Limit defaults to 50.",
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
  description:
    "Fetch the full content of a single memory by its UUID. Use after memory.search or memory.list when you need the full body — list/search return summaries.",
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
  description:
    "Soft-delete a memory when it becomes stale or wrong — e.g., the user changes a preference, or a fact you saved turns out to be incorrect. ALWAYS prefer memory.update over delete-then-write for content corrections; only delete when the memory genuinely shouldn't exist anymore. Soft delete preserves the audit trail.",
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

const memoryUpdate: ToolDef = {
  name: "memory.update",
  description:
    "Edit an existing memory in place — for correcting a stored fact, expanding it with new detail, adjusting tags, or moving it to a different scope/project. Preserves the memory's id (so callers referencing it don't break) and re-embeds automatically when content changes. Pass `scope` and/or `project` to reclassify a memory between user-global and project-attached without recreating it. Use this — not delete + write — whenever you're refining what's already there.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", format: "uuid" },
      content: { type: "string", description: "Replacement content (1–64,000 chars)." },
      tags: { type: "array", items: { type: "string" }, description: "Replacement tag list." },
      scope: {
        type: "string",
        enum: ["project", "user"],
        description:
          "New scope. When 'project', `project` must be set. When 'user', `project` must be omitted.",
      },
      project: {
        type: "string",
        description:
          "Project key the memory should attach to (required and only valid when scope='project'). Project is upserted if it doesn't exist.",
      },
    },
    required: ["id"],
  },
  async handler(args, ctx) {
    const parsed = MemoryUpdateInput.safeParse(args);
    if (!parsed.success) return err(parsed.error.message);

    const existingRows = await db
      .select({
        id: memories.id,
        content: memories.content,
        scope: memories.scope,
        projectId: memories.projectId,
        projectKey: projects.key,
      })
      .from(memories)
      .leftJoin(projects, eq(memories.projectId, projects.id))
      .where(
        and(
          eq(memories.id, parsed.data.id),
          eq(memories.userId, ctx.userId),
          isNull(memories.deletedAt),
        ),
      )
      .limit(1);
    const existing = existingRows[0];
    if (!existing) return err("not found");

    const update: Record<string, unknown> = { updatedAt: new Date() };
    if (parsed.data.tags !== undefined) update.tags = parsed.data.tags;
    if (parsed.data.content !== undefined && parsed.data.content !== existing.content) {
      update.content = parsed.data.content;
      update.embedding = await embedText(parsed.data.content);
    }

    let scopeChanged = false;
    let projectChanged = false;
    let newProjectKey: string | null = existing.projectKey ?? null;

    if (parsed.data.scope !== undefined) {
      if (parsed.data.scope === "user") {
        if (existing.scope !== "user") {
          update.scope = "user";
          scopeChanged = true;
        }
        if (existing.projectId !== null) {
          update.projectId = null;
          projectChanged = true;
          newProjectKey = null;
        }
      } else {
        // scope === 'project' — schema refine guarantees `project` is set
        const projectKey = parsed.data.project!;
        const projectId = await resolveProjectId(ctx, projectKey);
        if (!projectId) {
          return err(`unknown project '${projectKey}'; call project.identify first`);
        }
        if (existing.scope !== "project") {
          update.scope = "project";
          scopeChanged = true;
        }
        if (existing.projectId !== projectId) {
          update.projectId = projectId;
          projectChanged = true;
          newProjectKey = projectKey;
        }
      }
    }

    const updated = await db
      .update(memories)
      .set(update)
      .where(eq(memories.id, parsed.data.id))
      .returning({ id: memories.id, updatedAt: memories.updatedAt });

    const auditFields = Object.keys(update).filter((k) => k !== "updatedAt");
    const auditPayload: Record<string, unknown> = { fields: auditFields };
    if (scopeChanged || projectChanged) {
      auditPayload.scope = {
        from: existing.scope,
        to: update.scope ?? existing.scope,
      };
      auditPayload.projectKey = {
        from: existing.projectKey ?? null,
        to: newProjectKey,
      };
    }

    await db.insert(auditLog).values({
      userId: ctx.userId,
      actor: "mcp",
      action: "memory.update",
      entityType: "memory",
      entityId: updated[0]!.id,
      payload: auditPayload,
    });

    return ok(updated[0]!, `updated memory ${updated[0]!.id}`);
  },
};

const memorySearch: ToolDef = {
  name: "memory.search",
  description:
    "Search this user's stored memories BEFORE answering any question that might depend on something they told you in a past conversation — their preferences, infrastructure choices, project decisions, references, ongoing initiatives. Also call at the start of work on a known project to load semantic context. The query should be the topic you're looking up in natural language — don't pre-keyword it. Combines vector similarity, Postgres full-text, and tag overlap via RRF; each result carries per-source rank so you can tell whether the hit is a strong semantic match or a weak vector-only one. Cheap; lean toward calling it.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Natural-language query." },
      project: { type: "string", description: "Restrict to a single project key." },
      scope: { type: "string", enum: ["project", "user"] },
      tags: { type: "array", items: { type: "string" }, description: "Boost results with these tags." },
      limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
    },
    required: ["query"],
  },
  async handler(args, ctx) {
    const parsed = MemorySearchInput.safeParse(args);
    if (!parsed.success) return err(parsed.error.message);

    const { query, scope, tags, limit } = parsed.data;
    const projectId = parsed.data.project
      ? await resolveProjectId(ctx, parsed.data.project)
      : null;
    if (parsed.data.project && !projectId) {
      return ok({ items: [], debug: { vec: 0, fts: 0, tag: 0 } }, "0 results (unknown project)");
    }

    const result = await searchMemories(
      ctx.userId,
      query,
      { scope, projectKey: parsed.data.project, tags },
      limit,
    );

    if (result.hits.length === 0) {
      return ok({ items: [], debug: result.debug }, "0 results");
    }

    const topIds = result.hits.map((h) => h.id);
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
      .where(inArray(memories.id, topIds));

    const byId = new Map(rows.map((r) => [r.id, r]));
    const items = result.hits.flatMap((hit) => {
      const row = byId.get(hit.id);
      if (!row) return [];
      return [
        {
          ...row,
          _rank: hit.rank,
        },
      ];
    });

    return ok({ items, debug: result.debug }, `${items.length} result(s)`);
  },
};

export const tools: ToolDef[] = [
  projectIdentify,
  memoryWrite,
  memoryUpdate,
  memoryList,
  memoryGet,
  memorySearch,
  memoryDelete,
];

export const toolMap: Record<string, ToolDef> = Object.fromEntries(
  tools.map((t) => [t.name, t]),
);
