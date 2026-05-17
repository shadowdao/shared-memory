import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  memories,
  projects,
  projectShares,
  groups,
  auditLog,
} from "@/lib/db/schema";
import {
  MemoryIdInput,
  MemoryListInput,
  MemorySearchInput,
  MemoryUpdateInput,
  MemoryWriteInput,
  ProjectIdentifyInput,
  SnippetPutInput,
  SnippetGetInput,
  SnippetListInput,
  SnippetDeleteInput,
} from "@shared-memory/schemas";
import { embedText } from "@/lib/embedder";
import { searchMemories } from "@/lib/memories";
import {
  getSnippet,
  putSnippet,
  listSnippets,
  softDeleteSnippet,
} from "@/lib/snippets";
import {
  CONCURRENT_EDIT_ERROR,
  canWriteProject,
  getProjectAccess,
  readableProjectIds,
} from "@/lib/access";
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

/**
 * Resolve a project_id for a project key visible to this user. Prefers
 * an owned project, falls back to any project shared with one of the
 * user's groups (any access level — read is enough to resolve the id).
 * Returns null when no visible project matches.
 */
async function resolveProjectId(
  ctx: UserContext,
  projectKey: string | undefined,
): Promise<string | null> {
  if (!projectKey) return null;
  const owned = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.userId, ctx.userId), eq(projects.key, projectKey)))
    .limit(1);
  if (owned[0]) return owned[0].id;

  if (ctx.groups.length === 0) return null;

  const accessibleIds = await readableProjectIds(ctx.userId, ctx.groups);
  if (accessibleIds.length === 0) return null;
  const shared = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.key, projectKey), inArray(projects.id, accessibleIds)))
    .limit(1);
  return shared[0]?.id ?? null;
}

/**
 * Resolve the project key from a tool call: explicit `project` arg takes
 * precedence; otherwise fall back to the context-level default (the
 * `X-Project-Key` header parsed by the MCP route).
 */
function projectKeyOrDefault(
  ctx: UserContext,
  arg: string | undefined,
): string | undefined {
  return arg ?? ctx.defaultProjectKey;
}

/**
 * If the args object has no explicit `project` key, inject the request-
 * scoped `defaultProjectKey` from the `X-Project-Key` header (when set).
 * This lets a client pin every call to one project without restating it
 * per tool invocation. Returns a new object — the original is untouched.
 *
 * The injection rule is: inject when the caller plausibly intends a
 * project scope. Concretely we inject when EITHER:
 *
 *   * `scope` is explicitly `'project'`, OR
 *   * `scope` is omitted AND the tool's natural default IS project-scope
 *     (memory.write defaults to project; snippet.put defaults to user).
 *
 * We never inject when `scope === 'user'` is explicit — the schemas refine
 * `(scope='user', project=<anything>)` as invalid. An explicit `project`
 * argument always wins and we never overwrite it.
 *
 * `defaultScope` is the tool's own default (e.g. 'project' for memory.*,
 * 'user' for snippet.*). For filter tools that have no scope default
 * (memory.list, memory.search, snippet.list), pass 'project' — those
 * cases treat the header as a project filter and benefit from injection.
 */
function withDefaultProject(
  args: unknown,
  ctx: UserContext,
  defaultScope: "project" | "user" = "project",
): unknown {
  if (!ctx.defaultProjectKey) return args;
  if (args === null || typeof args !== "object" || Array.isArray(args)) return args;
  const obj = args as Record<string, unknown>;
  if (obj.project !== undefined) return args;
  if (obj.scope === "user") return args;
  if (obj.scope === undefined && defaultScope === "user") return args;
  return { ...obj, project: ctx.defaultProjectKey };
}

// ---------- tools ----------

const projectIdentify: ToolDef = {
  name: "project.identify",
  description:
    "Call ONCE near the start of every session that has a project context — a repo you're working in, a service you're debugging, etc. — to register or look up that project so subsequent project-scoped memories attach correctly. Use a stable `key` you can reproduce next session (repo name, repo URL, or working directory basename). Returns shared projects you have access to in addition to your own; when an owned and a shared project would both match the same key, the owned one wins (a server-side warning is logged so the collision is debuggable). Skip if the work is purely scratch / not tied to a specific codebase.",
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

    // 1) Owned project with this key wins.
    const ownedRow = await db
      .select({
        id: projects.id,
        key: projects.key,
        displayName: projects.displayName,
        createdAt: projects.createdAt,
        userId: projects.userId,
      })
      .from(projects)
      .where(and(eq(projects.userId, ctx.userId), eq(projects.key, parsed.data.key)))
      .limit(1);

    // 2) If the user belongs to any groups, find shared projects with
    //    this key. We collect ALL matches because we need to (a) detect
    //    a collision with the owned match to emit the warning, and
    //    (b) collapse the access level across the user's groups.
    let sharedMatches: Array<{
      projectId: string;
      displayName: string | null;
      createdAt: Date;
      ownerUserId: string;
      access: "ro" | "rw";
    }> = [];
    if (ctx.groups.length > 0) {
      const rows = await db
        .select({
          projectId: projects.id,
          displayName: projects.displayName,
          createdAt: projects.createdAt,
          ownerUserId: projects.userId,
          access: projectShares.access,
        })
        .from(projectShares)
        .innerJoin(groups, eq(groups.id, projectShares.groupId))
        .innerJoin(projects, eq(projects.id, projectShares.projectId))
        .where(
          and(
            inArray(groups.name, ctx.groups),
            eq(projects.key, parsed.data.key),
          ),
        );
      sharedMatches = rows as typeof sharedMatches;
    }

    if (ownedRow[0]) {
      // Owned beats shared — but if there's a shared collision, audit
      // the warning so an operator can see the ambiguity in the log
      // surface. We don't surface it on the caller's response.
      const collidesWithShared = sharedMatches.some(
        (s) => s.projectId !== ownedRow[0]!.id,
      );
      if (collidesWithShared) {
        await db.insert(auditLog).values({
          userId: ctx.userId,
          actor: "system",
          action: "project.identify.collision",
          entityType: "project",
          entityId: ownedRow[0].id,
          payload: {
            projectKey: parsed.data.key,
            ownedProjectId: ownedRow[0].id,
            sharedProjectIds: sharedMatches.map((s) => s.projectId),
            note: "owned project preferred over shared collision",
          },
        });
      }
      // Apply display_name update only on the owned project.
      if (parsed.data.display_name) {
        await db
          .update(projects)
          .set({ displayName: parsed.data.display_name, updatedAt: new Date() })
          .where(eq(projects.id, ownedRow[0].id));
      }
      return ok(
        {
          id: ownedRow[0].id,
          key: ownedRow[0].key,
          displayName: parsed.data.display_name ?? ownedRow[0].displayName,
          createdAt: ownedRow[0].createdAt,
          shared: false,
          access: "owner" as const,
          readOnly: false,
        },
        `project ${ownedRow[0].key} (${ownedRow[0].id})`,
      );
    }

    if (sharedMatches.length > 0) {
      // Collapse to the strongest access level across the user's groups.
      const access = sharedMatches.some((s) => s.access === "rw") ? "rw" : "ro";
      // De-dupe — multiple group rows can point at the same project.
      const first = sharedMatches[0]!;
      return ok(
        {
          id: first.projectId,
          key: parsed.data.key,
          displayName: first.displayName,
          createdAt: first.createdAt,
          shared: true,
          access,
          readOnly: access === "ro",
        },
        `project ${parsed.data.key} (shared, ${access})`,
      );
    }

    // 3) Nothing matched — create a new owned project.
    const created = await db
      .insert(projects)
      .values({
        userId: ctx.userId,
        key: parsed.data.key,
        displayName: parsed.data.display_name ?? null,
      })
      .returning({
        id: projects.id,
        key: projects.key,
        displayName: projects.displayName,
        createdAt: projects.createdAt,
      });

    const p = created[0]!;
    return ok(
      {
        id: p.id,
        key: p.key,
        displayName: p.displayName,
        createdAt: p.createdAt,
        shared: false,
        access: "owner" as const,
        readOnly: false,
      },
      `project ${p.key} (${p.id})`,
    );
  },
};

const memoryWrite: ToolDef = {
  name: "memory.write",
  description:
    "Save a durable fact, preference, or decision that ANY future Claude Code session on ANY of this user's machines should know. Call this when the user shares something that meets ALL of: (1) likely to matter beyond this conversation, (2) not derivable from reading current code/git, (3) would surprise a future you if forgotten. Examples: 'I use HAProxy at home' (user-scope), 'we chose Drizzle over Prisma because of bundle size' (project-scope), 'our prod DB is at db.example.com' (user-scope reference). Use scope='user' for facts about the human or their infra; scope='project' for facts tied to a specific codebase (always preceded by project.identify). In shared projects (i.e. ones surfaced by project.identify with `shared: true`), anyone with rw access can write — your memory becomes visible to every member of every group the project is shared with. Defaults `project` to the X-Project-Key header value if not supplied. Sensitive info (API keys, credentials, connection strings the user actively shares with you) IS appropriate to save here — this server is OIDC-gated and per-user; safer than writing to local container files. DO NOT use for: transient task state, this-session-only scratch notes, or container-specific facts (those belong in the built-in file-based memory at ~/.claude/.../memory/). Tags help retrieval.",
  inputSchema: {
    type: "object",
    properties: {
      content: { type: "string", description: "Memory content (1–64,000 chars)." },
      project: {
        type: "string",
        description:
          "Project key. Required when scope='project'; defaults to the X-Project-Key request header if present.",
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
    const parsed = MemoryWriteInput.safeParse(withDefaultProject(args, ctx));
    if (!parsed.success) return err(parsed.error.message);

    const scope = parsed.data.scope;
    let projectId: string | null = null;
    let projectKey: string | undefined = undefined;
    if (scope === "project") {
      projectKey = projectKeyOrDefault(ctx, parsed.data.project);
      if (!projectKey) {
        return err("scope=project requires `project` key (or X-Project-Key header)");
      }
      projectId = await resolveProjectId(ctx, projectKey);
      if (!projectId) {
        return err(`unknown project '${projectKey}'; call project.identify first`);
      }
      // Authorize write. Owner always allowed; otherwise require rw.
      const allowed = await canWriteProject(ctx.userId, ctx.groups, projectId);
      if (!allowed) {
        return err(`no write access to project '${projectKey}'`);
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
        lastEditedBy: ctx.userId,
      })
      .returning({ id: memories.id, createdAt: memories.createdAt });

    const m = inserted[0]!;
    await db.insert(auditLog).values({
      userId: ctx.userId,
      actor: "mcp",
      action: "memory.write",
      entityType: "memory",
      entityId: m.id,
      payload: { scope, projectKey: projectKey ?? null, tags: parsed.data.tags ?? [] },
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
    const parsed = MemoryListInput.safeParse(withDefaultProject(args, ctx));
    if (!parsed.success) return err(parsed.error.message);

    // Visibility: own rows OR rows in any project shared with my groups.
    const accessibleIds = await readableProjectIds(ctx.userId, ctx.groups);
    const visibilityClause =
      accessibleIds.length > 0
        ? or(eq(memories.userId, ctx.userId), inArray(memories.projectId, accessibleIds))
        : eq(memories.userId, ctx.userId);

    const where = [visibilityClause!, isNull(memories.deletedAt)];

    if (parsed.data.scope) where.push(eq(memories.scope, parsed.data.scope));

    const requestedKey = projectKeyOrDefault(ctx, parsed.data.project);
    if (requestedKey) {
      const projectId = await resolveProjectId(ctx, requestedKey);
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
        version: memories.version,
        lastEditedBy: memories.lastEditedBy,
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
      .where(and(eq(memories.id, parsed.data.id), isNull(memories.deletedAt)))
      .limit(1);

    if (!row[0]) return err("not found");

    // Authorize read: own row, OR project-scope row in an accessible
    // project. Anything else looks "not found" to the caller.
    const m = row[0];
    if (m.userId !== ctx.userId) {
      if (!m.projectId) return err("not found");
      const access = await getProjectAccess(ctx.userId, ctx.groups, m.projectId);
      if (access === null) return err("not found");
    }

    return ok(m, `memory ${m.id}`);
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

    // Look up the row first to authorize. We can't rely on a
    // single-statement WHERE clause because shared-project writes
    // need a per-project access check.
    const target = await db
      .select({
        id: memories.id,
        userId: memories.userId,
        projectId: memories.projectId,
        scope: memories.scope,
      })
      .from(memories)
      .where(and(eq(memories.id, parsed.data.id), isNull(memories.deletedAt)))
      .limit(1);
    const m = target[0];
    if (!m) return err("not found");

    if (m.userId !== ctx.userId) {
      // Not the owner. User-scope memories can only be deleted by their
      // owner; project-scope require rw access on the project.
      if (m.scope === "user" || !m.projectId) return err("not found");
      const allowed = await canWriteProject(ctx.userId, ctx.groups, m.projectId);
      if (!allowed) return err("no write access to this project");
    }

    const updated = await db
      .update(memories)
      .set({ deletedAt: new Date(), lastEditedBy: ctx.userId })
      .where(and(eq(memories.id, parsed.data.id), isNull(memories.deletedAt)))
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
    "Edit an existing memory in place — for correcting a stored fact, expanding it with new detail, adjusting tags, or moving it to a different scope/project. Preserves the memory's id (so callers referencing it don't break) and re-embeds automatically when content changes. Pass `scope` and/or `project` to reclassify a memory between user-global and project-attached without recreating it. In shared projects, anyone in a rw-access group can edit any memory — pass `version` (returned by memory.get / memory.list) to detect concurrent edits and avoid clobbering. The server bumps `version` on every successful update; a stale `version` returns the concurrent-edit error. Use this — not delete + write — whenever you're refining what's already there.",
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
          "Project key the memory should attach to (required and only valid when scope='project'). The project must already exist — call `project.identify` first if it doesn't.",
      },
      version: {
        type: "integer",
        minimum: 0,
        description:
          "Optimistic-locking token from memory.get / memory.list. When supplied, the update is rejected if the row was edited by someone else since you read it.",
      },
    },
    required: ["id"],
  },
  async handler(args, ctx) {
    const parsed = MemoryUpdateInput.safeParse(withDefaultProject(args, ctx));
    if (!parsed.success) return err(parsed.error.message);

    const existingRows = await db
      .select({
        id: memories.id,
        content: memories.content,
        scope: memories.scope,
        projectId: memories.projectId,
        projectKey: projects.key,
        version: memories.version,
        userId: memories.userId,
      })
      .from(memories)
      .leftJoin(projects, eq(memories.projectId, projects.id))
      .where(and(eq(memories.id, parsed.data.id), isNull(memories.deletedAt)))
      .limit(1);
    const existing = existingRows[0];
    if (!existing) return err("not found");

    // Authorize write.
    if (existing.scope === "user") {
      if (existing.userId !== ctx.userId) return err("not found");
    } else if (existing.projectId) {
      const allowed = await canWriteProject(ctx.userId, ctx.groups, existing.projectId);
      if (!allowed) return err("no write access to this project");
    }

    const update: Record<string, unknown> = {
      updatedAt: new Date(),
      lastEditedBy: ctx.userId,
      version: existing.version + 1,
    };
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
        // scope === 'project' — schema refine guarantees `project` is set.
        const projectKey = parsed.data.project!;
        const projectId = await resolveProjectId(ctx, projectKey);
        if (!projectId) {
          return err(`unknown project '${projectKey}'; call project.identify first`);
        }
        // Moving INTO a project requires write access there.
        const allowedTarget = await canWriteProject(ctx.userId, ctx.groups, projectId);
        if (!allowedTarget) {
          return err(`no write access to project '${projectKey}'`);
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

    const expectedVersion = parsed.data.version ?? existing.version;
    const updated = await db
      .update(memories)
      .set(update)
      .where(
        and(
          eq(memories.id, parsed.data.id),
          eq(memories.version, expectedVersion),
        ),
      )
      .returning({
        id: memories.id,
        updatedAt: memories.updatedAt,
        version: memories.version,
      });

    if (!updated[0]) return err(CONCURRENT_EDIT_ERROR);

    const auditFields = Object.keys(update).filter(
      (k) => k !== "updatedAt" && k !== "version" && k !== "lastEditedBy",
    );
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
    const parsed = MemorySearchInput.safeParse(withDefaultProject(args, ctx));
    if (!parsed.success) return err(parsed.error.message);

    const { query, scope, tags, limit } = parsed.data;
    const requestedKey = projectKeyOrDefault(ctx, parsed.data.project);
    const projectId = requestedKey ? await resolveProjectId(ctx, requestedKey) : null;
    if (requestedKey && !projectId) {
      return ok({ items: [], debug: { vec: 0, fts: 0, tag: 0 } }, "0 results (unknown project)");
    }

    const result = await searchMemories(
      ctx.userId,
      query,
      { scope, projectKey: requestedKey, tags, groupNames: ctx.groups },
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
        version: memories.version,
        lastEditedBy: memories.lastEditedBy,
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

// ---------- snippet tools ----------

const snippetPut: ToolDef = {
  name: "snippet.put",
  description:
    "Save or update a named reusable artifact — a template, format, or checklist the user wants applied consistently. Call this when the user says 'remember this as my X template', 'save this format as Y', or 'use this checklist whenever I do Z'. Different from memory.write (which is for facts you'll later search): snippets are fetched by EXACT name, not searched, so the name is the contract — pick something stable and predictable (e.g. 'pr-description-format', 'commit-msg-rules', 'code-review-checklist'). Use scope='user' (default) for personal templates that apply everywhere; scope='project' for repo-specific variants (requires `project`, same key you used for project.identify, defaulted from the X-Project-Key header). Re-calling with the same name+scope replaces the body in place — there is no separate update tool. In shared projects, anyone in a rw-access group can edit any project-scope snippet — pass `version` (returned by snippet.get / snippet.list) to detect concurrent edits and avoid clobbering. Tags help browsing in the Web UI; they do NOT enable search.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description:
          "Stable identifier for this snippet (1–200 chars; alphanumerics + ._-/). Used as the lookup key — pick something you'll remember.",
      },
      body: {
        type: "string",
        description: "The full template / format / checklist body (1–64,000 chars).",
      },
      description: {
        type: "string",
        description: "Optional short note on when to use this snippet.",
      },
      scope: {
        type: "string",
        enum: ["project", "user"],
        description:
          "'user' (default) = applies everywhere. 'project' = tied to one repo and requires `project` (or X-Project-Key header).",
      },
      project: {
        type: "string",
        description:
          "Project key. Required for scope='project'; defaults to the X-Project-Key request header if present.",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Optional tags for grouping in the Web UI.",
      },
      version: {
        type: "integer",
        minimum: 0,
        description:
          "Optimistic-locking token from snippet.get / snippet.list. Only consulted on the update path (i.e. when a row with this name+scope+project already exists).",
      },
    },
    required: ["name", "body"],
  },
  async handler(args, ctx) {
    // snippet.put defaults to user-scope, so a header-supplied project key
    // is only honored when the caller explicitly says `scope='project'`.
    const parsed = SnippetPutInput.safeParse(withDefaultProject(args, ctx, "user"));
    if (!parsed.success) return err(parsed.error.message);

    // Apply X-Project-Key default for scope=project.
    const projectKey =
      parsed.data.scope === "project"
        ? projectKeyOrDefault(ctx, parsed.data.project)
        : undefined;
    if (parsed.data.scope === "project" && !projectKey) {
      return err("scope=project requires `project` (or X-Project-Key header)");
    }

    if (parsed.data.scope === "project") {
      const exists = await resolveProjectId(ctx, projectKey!);
      // It's OK for the project not to exist — putSnippet will create
      // it owned by the caller. But if it DOES exist as a shared
      // project, we need rw to write through it; the helper enforces
      // that.
      void exists;
    }

    try {
      const { snippet, inserted } = await putSnippet(ctx.userId, {
        name: parsed.data.name,
        body: parsed.data.body,
        description: parsed.data.description,
        tags: parsed.data.tags,
        scope: parsed.data.scope,
        projectKey,
        groupNames: ctx.groups,
        version: parsed.data.version,
      });

      await db.insert(auditLog).values({
        userId: ctx.userId,
        actor: "mcp",
        action: inserted ? "snippet.put" : "snippet.update",
        entityType: "snippet",
        entityId: snippet.id,
        payload: {
          name: snippet.name,
          scope: snippet.scope,
          projectKey: snippet.projectKey,
          tags: snippet.tags,
        },
      });

      return ok(
        {
          id: snippet.id,
          name: snippet.name,
          scope: snippet.scope,
          project: snippet.projectKey,
          version: snippet.version,
          inserted,
        },
        `${inserted ? "wrote" : "updated"} snippet '${snippet.name}' (${snippet.scope})`,
      );
    } catch (e) {
      return err(e instanceof Error ? e.message : "snippet.put failed");
    }
  },
};

const snippetGet: ToolDef = {
  name: "snippet.get",
  description:
    "Fetch a snippet by its EXACT name. Call this when the user references something by a stable label — 'use my pr-description-format', 'apply the commit-msg-rules', 'follow the code-review-checklist'. Different from memory.search/memory.get: snippets are addressed by name, not UUID, and there is no fuzzy matching — the name must match exactly. If you provide `project` alone (no `scope`), the server prefers the project-scope variant for that repo and falls back to the user-scope default. Pass scope='user' to force the global version even when a project variant exists.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Exact snippet name." },
      scope: {
        type: "string",
        enum: ["project", "user"],
        description:
          "Force a specific scope. Omit to prefer the project variant (if `project` is given), else user.",
      },
      project: {
        type: "string",
        description:
          "Project key. Required for scope='project'; optional otherwise (enables project-preferred lookup).",
      },
    },
    required: ["name"],
  },
  async handler(args, ctx) {
    const parsed = SnippetGetInput.safeParse(withDefaultProject(args, ctx));
    if (!parsed.success) return err(parsed.error.message);

    const requestedKey = projectKeyOrDefault(ctx, parsed.data.project);
    const snippet = await getSnippet(ctx.userId, {
      name: parsed.data.name,
      scope: parsed.data.scope,
      projectKey: requestedKey,
      groupNames: ctx.groups,
    });

    if (!snippet) return err(`snippet '${parsed.data.name}' not found`);

    return ok(
      {
        id: snippet.id,
        name: snippet.name,
        body: snippet.body,
        description: snippet.description,
        scope: snippet.scope,
        project: snippet.projectKey,
        tags: snippet.tags,
        version: snippet.version,
        lastEditedBy: snippet.lastEditedBy,
        createdAt: snippet.createdAt,
        updatedAt: snippet.updatedAt,
      },
      `snippet '${snippet.name}' (${snippet.scope})`,
    );
  },
};

const snippetList: ToolDef = {
  name: "snippet.list",
  description:
    "Browse this user's snippets — useful at session start to see what templates are available before deciding whether to call snippet.get. Unlike memory.list, snippets are sorted by recency of update (they're meant to evolve over time). Filter by scope, project, or tags. Use this when you suspect a relevant template exists but you don't know the exact name; if you DO know the name, call snippet.get directly.",
  inputSchema: {
    type: "object",
    properties: {
      project: {
        type: "string",
        description: "Filter by project key (returns only project-scope snippets for that project).",
      },
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
    const parsed = SnippetListInput.safeParse(withDefaultProject(args, ctx));
    if (!parsed.success) return err(parsed.error.message);

    const requestedKey = projectKeyOrDefault(ctx, parsed.data.project);
    const rows = await listSnippets(ctx.userId, {
      scope: parsed.data.scope,
      projectKey: requestedKey,
      tags: parsed.data.tags,
      limit: parsed.data.limit,
      groupNames: ctx.groups,
    });

    const items = rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      scope: r.scope,
      project: r.projectKey,
      tags: r.tags,
      version: r.version,
      lastEditedBy: r.lastEditedBy,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));

    return ok({ items }, `${items.length} snippet(s)`);
  },
};

const snippetDelete: ToolDef = {
  name: "snippet.delete",
  description:
    "Soft-delete a snippet by name when it becomes stale or wrong — e.g., the user revamps a template and the old version shouldn't be reachable anymore. ALWAYS prefer snippet.put with the same name (which replaces in place) over delete-then-put when you're just refining the body. Only delete when the snippet genuinely shouldn't exist. Provide `scope` (and `project` for project-scope) to disambiguate when the same name exists in multiple scopes.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Exact snippet name." },
      scope: { type: "string", enum: ["project", "user"] },
      project: { type: "string", description: "Project key (required for scope='project')." },
    },
    required: ["name"],
  },
  async handler(args, ctx) {
    const parsed = SnippetDeleteInput.safeParse(withDefaultProject(args, ctx));
    if (!parsed.success) return err(parsed.error.message);

    const requestedKey = projectKeyOrDefault(ctx, parsed.data.project);
    try {
      const deleted = await softDeleteSnippet(ctx.userId, {
        name: parsed.data.name,
        scope: parsed.data.scope,
        projectKey: requestedKey,
        groupNames: ctx.groups,
      });
      if (!deleted) return err(`snippet '${parsed.data.name}' not found`);

      await db.insert(auditLog).values({
        userId: ctx.userId,
        actor: "mcp",
        action: "snippet.delete",
        entityType: "snippet",
        entityId: deleted.id,
        payload: {
          name: parsed.data.name,
          scope: deleted.scope,
          projectKey: deleted.projectKey,
        },
      });

      return ok(
        { id: deleted.id, name: parsed.data.name, deleted: true },
        `deleted snippet '${parsed.data.name}' (${deleted.scope})`,
      );
    } catch (e) {
      return err(e instanceof Error ? e.message : "snippet.delete failed");
    }
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
  snippetPut,
  snippetGet,
  snippetList,
  snippetDelete,
];

export const toolMap: Record<string, ToolDef> = Object.fromEntries(
  tools.map((t) => [t.name, t]),
);
