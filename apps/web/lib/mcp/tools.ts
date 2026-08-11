import { and, arrayContains, desc, eq, inArray, isNull, or } from "drizzle-orm";
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
  MemoryDeleteInput,
  MemoryListInput,
  MemoryPatchInput,
  MemorySearchInput,
  MemoryUpdateInput,
  MemoryWriteInput,
  ProjectIdentifyInput,
  SnippetPutInput,
  SnippetGetInput,
  SnippetListInput,
  SnippetDeleteInput,
} from "@shared-memory/schemas";
import { searchMemories } from "@/lib/memories";
import {
  createMemory,
  patchMemory,
  softDeleteMemory,
  updateMemory,
  type Actor,
  type ProjectResolver,
} from "@/lib/memory-mutations";
import {
  getSnippet,
  putSnippet,
  listSnippets,
  softDeleteSnippet,
} from "@/lib/snippets";
import { getProjectAccess, readableProjectIds } from "@/lib/access";
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

/** Adapt an MCP request context to the shared mutation layer. */
function mcpActor(ctx: UserContext): Actor {
  return { userId: ctx.userId, groups: ctx.groups, via: "mcp" };
}

/**
 * Project resolution for MCP writes. Unlike the Web UI, the MCP surface
 * never auto-creates a project — an unknown key is an error telling the
 * caller to run project.identify first, which keeps agents from silently
 * spawning near-miss projects off a typo'd key.
 */
function mcpProjectResolver(ctx: UserContext): ProjectResolver {
  return async (key: string) => {
    const id = await resolveProjectId(ctx, key);
    if (!id) {
      return { ok: false, error: `unknown project '${key}'; call project.identify first` };
    }
    return { ok: true, value: id };
  };
}

// ---------- tools ----------

const projectIdentify: ToolDef = {
  name: "project.identify",
  description:
    "Call ONCE near the start of every session that has a project context — a repo you're working in, a service you're debugging, etc. — to register or look up that project so subsequent project-scoped memories attach correctly. **Look up the key in this order:** (1) `.shared-memory-project` at the repo root (single-line text file with just the project key; walk up from cwd to find it — same lookup style as `.gitignore` / `.nvmrc`). (2) If no file, fall back to a stable inference: repo name, git remote slug, or working directory basename. The file convention exists so teams sharing a repo all hit the same shared project automatically — prefer it over guessing. **Pass `source` based on how you resolved the key** — 'file', 'explicit', 'header', or 'inferred' — so the server can decide whether to suggest the user create `.shared-memory-project`. If the response carries a `setupHint`, briefly relay its `message` and `command` to the user (one short sentence, don't over-explain — they'll decide). Returns shared projects you have access to in addition to your own; when an owned and a shared project would both match the same key, the owned one wins (a server-side warning is logged so the collision is debuggable). Skip if the work is purely scratch / not tied to a specific codebase.",
  inputSchema: {
    type: "object",
    properties: {
      key: {
        type: "string",
        description:
          "Stable project identifier. First check `.shared-memory-project` at the repo root (one line of plain text, that line IS the key) — that's the canonical source when present. Otherwise use repo name, repo URL, or any string the caller can reproduce across sessions.",
      },
      display_name: {
        type: "string",
        description: "Human-readable name shown in the Web UI. Optional.",
      },
      source: {
        type: "string",
        enum: ["file", "explicit", "header", "inferred"],
        description:
          "How you resolved the project key. Pass 'file' when you read it from `.shared-memory-project`, 'explicit' when the user named it, 'header' when you used the X-Project-Key default, or 'inferred' when you guessed from repo/cwd. Anything but 'file' may surface a setupHint in the response.",
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
          ...buildSetupHint(parsed.data.key, parsed.data.source),
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
        ...buildSetupHint(p.key, parsed.data.source),
      },
      `project ${p.key} (${p.id})`,
    );
  },
};

/**
 * Returns a `setupHint` field when the caller resolved the project key
 * by anything OTHER than reading `.shared-memory-project`. Surfaces a
 * copy-pasteable command + a short message Claude is told to relay to
 * the user. Spreading `{}` from a "no hint needed" branch is the
 * cleanest way to conditionally add the field without nullish noise.
 */
function buildSetupHint(
  projectKey: string,
  source: ProjectIdentifyInput["source"],
): { setupHint?: { message: string; command: string } } {
  if (source === "file") return {};
  return {
    setupHint: {
      message:
        "This repo doesn't appear to have a `.shared-memory-project` file. Committing one ties every collaborator's Claude Code to the same shared project automatically — no per-machine config. Want me to commit it?",
      command: `echo "${projectKey}" > .shared-memory-project`,
    },
  };
}

const memoryWrite: ToolDef = {
  name: "memory.write",
  description:
    "Save a durable fact, preference, or decision that ANY future Claude Code session on ANY of this user's machines should know. Call this when the user shares something that meets ALL of: (1) likely to matter beyond this conversation, (2) not derivable from reading current code/git, (3) would surprise a future you if forgotten. Examples: 'I use HAProxy at home' (user-scope), 'we chose Drizzle over Prisma because of bundle size' (project-scope), 'our prod DB is at db.example.com' (user-scope reference). Use scope='user' for facts about the human or their infra; scope='project' for facts tied to a specific codebase (always preceded by project.identify; project key should come from `.shared-memory-project` at the repo root when present). In shared projects (i.e. ones surfaced by project.identify with `shared: true`), anyone with rw access can write — your memory becomes visible to every member of every group the project is shared with. Defaults `project` to the X-Project-Key header value if not supplied. Sensitive info (API keys, credentials, connection strings the user actively shares with you) IS appropriate to save here — this server is OIDC-gated and per-user; safer than writing to local container files. DO NOT use for: transient task state, this-session-only scratch notes, or container-specific facts (those belong in the built-in file-based memory at ~/.claude/.../memory/). Tags help retrieval.",
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

    // Fold the X-Project-Key fallback in before the shared path sees it.
    const input = {
      ...parsed.data,
      project: projectKeyOrDefault(ctx, parsed.data.project),
    };
    if (input.scope === "project" && !input.project) {
      return err("scope=project requires `project` key (or X-Project-Key header)");
    }

    const res = await createMemory(mcpActor(ctx), input, mcpProjectResolver(ctx));
    if (!res.ok) return err(res.error);
    return ok(res.value, `wrote memory ${res.value.id}`);
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
      // Require ALL listed tags (array containment). Use Drizzle's
      // arrayContains so the JS array binds as a single text[] param
      // (via the column's toDriver) rather than being expanded into
      // positional params — a raw `${tags}::text[]` template expands to
      // `($1)::text[]` / `($1,$2)::text[]`, which Postgres rejects as a
      // malformed array literal / record cast.
      where.push(arrayContains(memories.tags, parsed.data.tags));
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

    // Project explicitly rather than `select()`-ing the raw row. The
    // table carries `embedding` (384 floats) and `content_tsv` (the full
    // lexeme index, which outgrows `content` itself on large memories) —
    // both are Postgres retrieval internals that no MCP client can use,
    // and together they were the majority of every response. Returning
    // them also pushed large memories past the tool-output cap. This is
    // the same 9-field shape memory.list and memory.search return.
    const row = await db
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
        // Needed for the authorization check below; stripped before the
        // response so the payload matches list/search exactly.
        userId: memories.userId,
      })
      .from(memories)
      .where(and(eq(memories.id, parsed.data.id), isNull(memories.deletedAt)))
      .limit(1);

    if (!row[0]) return err("not found");

    // Authorize read: own row, OR project-scope row in an accessible
    // project. Anything else looks "not found" to the caller.
    const { userId, ...m } = row[0];
    if (userId !== ctx.userId) {
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
    "Soft-delete a memory when it becomes stale or wrong — e.g., the user changes a preference, or a fact you saved turns out to be incorrect. ALWAYS prefer memory.update over delete-then-write for content corrections; only delete when the memory genuinely shouldn't exist anymore. Soft delete preserves the audit trail. Pass `version` (returned by memory.get / memory.list) to detect concurrent edits — in shared projects another member may have updated the row since you read it.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", format: "uuid" },
      version: {
        type: "integer",
        minimum: 0,
        description:
          "If supplied, the delete fails with a concurrent-edit error when the row's current version doesn't match. Recommended for shared projects.",
      },
    },
    required: ["id"],
  },
  async handler(args, ctx) {
    const parsed = MemoryDeleteInput.safeParse(args);
    if (!parsed.success) return err(parsed.error.message);

    const res = await softDeleteMemory(mcpActor(ctx), parsed.data);
    if (!res.ok) return err(res.error);
    return ok({ id: res.value.id, deleted: true }, `deleted memory ${res.value.id}`);
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

    const res = await updateMemory(mcpActor(ctx), parsed.data, mcpProjectResolver(ctx));
    if (!res.ok) return err(res.error);
    return ok(res.value, `updated memory ${res.value.id}`);
  },
};

const memoryPatch: ToolDef = {
  name: "memory.patch",
  description:
    "Replace one exact snippet of a memory's content, leaving the rest untouched — the same mental model as editing a file. Use this INSTEAD of memory.update whenever you're making a small edit to a large memory: adding an entry under a heading, correcting a line, updating a status. memory.update requires you to resend the entire document, which risks silently dropping content you didn't mean to touch; memory.patch only needs the fragment you're changing. `old_string` must appear EXACTLY once — if it's missing or ambiguous the call fails and nothing is changed, so include enough surrounding context to make it unique. Pass an empty `new_string` to delete the matched text. Re-embeds automatically, preserves the memory's id, and accepts `version` for the same concurrent-edit protection as memory.update.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", format: "uuid" },
      old_string: {
        type: "string",
        description:
          "The exact text to replace. Must occur exactly once in the memory's content — include surrounding lines if the fragment alone would be ambiguous.",
      },
      new_string: {
        type: "string",
        description:
          "The replacement text. May be empty to delete the matched text (the memory itself may not be left empty).",
      },
      version: {
        type: "integer",
        minimum: 0,
        description:
          "Optimistic-locking token from memory.get / memory.list. When supplied, the patch is rejected if the row was edited by someone else since you read it.",
      },
    },
    required: ["id", "old_string", "new_string"],
  },
  async handler(args, ctx) {
    const parsed = MemoryPatchInput.safeParse(args);
    if (!parsed.success) return err(parsed.error.message);

    const res = await patchMemory(mcpActor(ctx), parsed.data);
    if (!res.ok) return err(res.error);

    const { id, delta, contentLength } = res.value;
    return ok(
      res.value,
      `patched memory ${id} (${delta >= 0 ? "+" : ""}${delta} chars, now ${contentLength})`,
    );
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
      minScore: {
        type: "number",
        minimum: 0,
        maximum: 1,
        description:
          "Optional minimum Reciprocal Rank Fusion score for a hit to be returned. Default unset = no extra filter (every fused result returned). Set ~0.025 to require at least two rankers (vector + FTS, or +tag) to fire at rank 1, filtering out weak vector-only matches. The per-source ranks in each result are still the primary way to judge confidence.",
      },
    },
    required: ["query"],
  },
  async handler(args, ctx) {
    const parsed = MemorySearchInput.safeParse(withDefaultProject(args, ctx));
    if (!parsed.success) return err(parsed.error.message);

    const { query, scope, tags, limit, minScore } = parsed.data;
    const requestedKey = projectKeyOrDefault(ctx, parsed.data.project);
    const projectId = requestedKey ? await resolveProjectId(ctx, requestedKey) : null;
    if (requestedKey && !projectId) {
      return ok({ items: [], debug: { vec: 0, fts: 0, tag: 0 } }, "0 results (unknown project)");
    }

    const result = await searchMemories(
      ctx.userId,
      query,
      { scope, projectKey: requestedKey, tags, groupNames: ctx.groups, minScore },
      limit,
    );

    if (result.hits.length === 0) {
      return ok({ items: [], debug: result.debug }, "0 results");
    }

    const topIds = result.hits.map((h) => h.id);
    // Re-filter on deletedAt — close a tiny TOCTOU window where a row
    // could be soft-deleted between the visibility-aware search and this
    // re-fetch. Visibility itself is already enforced by `searchMemories`.
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
      .where(and(inArray(memories.id, topIds), isNull(memories.deletedAt)));

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

    try {
      // Authorization for shared-project writes lives inside putSnippet:
      // if the project exists and the caller lacks rw access on it, the
      // helper throws. If the project doesn't exist, the helper creates
      // it owned by the caller — auto-upsert semantics.
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
    "Soft-delete a snippet by name when it becomes stale or wrong — e.g., the user revamps a template and the old version shouldn't be reachable anymore. ALWAYS prefer snippet.put with the same name (which replaces in place) over delete-then-put when you're just refining the body. Only delete when the snippet genuinely shouldn't exist. Provide `scope` (and `project` for project-scope) to disambiguate when the same name exists in multiple scopes. Pass `version` (returned by snippet.get / snippet.list) to detect concurrent edits on shared-project snippets.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Exact snippet name." },
      scope: { type: "string", enum: ["project", "user"] },
      project: { type: "string", description: "Project key (required for scope='project')." },
      version: {
        type: "integer",
        minimum: 0,
        description:
          "If supplied, the delete fails with a concurrent-edit error when the row's current version doesn't match. Recommended for shared projects.",
      },
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
        version: parsed.data.version,
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
  memoryPatch,
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
