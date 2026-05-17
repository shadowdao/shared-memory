import { z } from "zod";

export const MemoryScope = z.enum(["project", "user"]);
export type MemoryScope = z.infer<typeof MemoryScope>;

export const MemoryVisibility = z.enum(["private", "shared", "team"]);
export type MemoryVisibility = z.infer<typeof MemoryVisibility>;

// Access level a group has on a shared project. Mirrors the Postgres
// `memory_access` enum defined by Agent A's groups migration.
export const MemoryAccess = z.enum(["ro", "rw"]);
export type MemoryAccess = z.infer<typeof MemoryAccess>;

export const ProjectKey = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9._\-/]+$/, "project key may only contain alphanumerics, ._-/");
export type ProjectKey = z.infer<typeof ProjectKey>;

export const MemoryContent = z.string().min(1).max(64_000);

export const Tags = z
  .array(z.string().min(1).max(64).regex(/^[a-zA-Z0-9._\-]+$/, "tag must be alphanumeric ._-"))
  .max(32)
  .default([]);

export const MemoryWriteInput = z.object({
  content: MemoryContent,
  project: ProjectKey.optional(),
  tags: Tags.optional(),
  scope: MemoryScope.default("project"),
});
export type MemoryWriteInput = z.infer<typeof MemoryWriteInput>;

export const MemoryListInput = z.object({
  project: ProjectKey.optional(),
  scope: MemoryScope.optional(),
  tags: z.array(z.string()).optional(),
  limit: z.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});
export type MemoryListInput = z.infer<typeof MemoryListInput>;

export const MemoryIdInput = z.object({
  id: z.string().uuid(),
});
export type MemoryIdInput = z.infer<typeof MemoryIdInput>;

export const MemoryUpdateInput = z.object({
  id: z.string().uuid(),
  content: MemoryContent.optional(),
  tags: Tags.optional(),
  scope: MemoryScope.optional(),
  project: ProjectKey.optional(),
  // Optimistic-locking token returned by memory.get / memory.list. When
  // present, the UPDATE matches on (id, version); a 0-row result means
  // someone else edited this memory since you read it.
  version: z.number().int().nonnegative().optional(),
})
  .refine(
    (v) =>
      v.content !== undefined ||
      v.tags !== undefined ||
      v.scope !== undefined ||
      v.project !== undefined,
    { message: "memory.update requires content, tags, scope, or project" },
  )
  .refine(
    (v) => v.scope !== "project" || (v.project !== undefined && v.project !== ""),
    { message: "scope='project' requires a non-empty project key" },
  )
  .refine((v) => v.scope !== "user" || v.project === undefined, {
    message: "scope='user' cannot have a project key",
  });
export type MemoryUpdateInput = z.infer<typeof MemoryUpdateInput>;

export const MemorySearchInput = z.object({
  query: z.string().min(1).max(2000),
  project: ProjectKey.optional(),
  scope: MemoryScope.optional(),
  tags: z.array(z.string()).optional(),
  limit: z.number().int().min(1).max(50).default(10),
});
export type MemorySearchInput = z.infer<typeof MemorySearchInput>;

export const ProjectIdentifyInput = z.object({
  key: ProjectKey,
  display_name: z.string().min(1).max(200).optional(),
});
export type ProjectIdentifyInput = z.infer<typeof ProjectIdentifyInput>;

// =============================================================================
// Snippets
//
// Snippets are named, exactly-reproducible artifacts (templates, formats,
// checklists). Unlike memories, they're fetched by EXACT name — never
// searched. They mirror the memory scope/project model so the same key
// can have a global default plus per-repo variants.
// =============================================================================

export const SnippetName = z
  .string()
  .min(1)
  .max(200)
  .regex(
    /^[a-zA-Z0-9._\-/]+$/,
    "snippet name may only contain alphanumerics, ._-/",
  );
export type SnippetName = z.infer<typeof SnippetName>;

export const SnippetBody = z.string().min(1).max(64_000);
export const SnippetDescription = z.string().max(2_000);

// Shared scope/project consistency: project-scope requires `project`,
// user-scope forbids it. Matches the DB CHECK constraint and the same
// refinement used implicitly for memories at the handler level.
const scopeProjectRefinement = {
  check: (v: { scope?: "project" | "user"; project?: string }) => {
    if (v.scope === "project") return Boolean(v.project);
    if (v.scope === "user") return v.project === undefined;
    return true;
  },
  message: "scope='project' requires `project`; scope='user' forbids `project`",
};

export const SnippetPutInput = z
  .object({
    name: SnippetName,
    body: SnippetBody,
    description: SnippetDescription.optional(),
    tags: Tags.optional(),
    scope: MemoryScope.default("user"),
    project: ProjectKey.optional(),
    // Optimistic-locking token used on the update path (when a row with
    // this name+scope+project already exists). Ignored on first put.
    version: z.number().int().nonnegative().optional(),
  })
  .refine(scopeProjectRefinement.check, { message: scopeProjectRefinement.message });
export type SnippetPutInput = z.infer<typeof SnippetPutInput>;

export const SnippetGetInput = z
  .object({
    name: SnippetName,
    scope: MemoryScope.optional(),
    project: ProjectKey.optional(),
  })
  .refine(scopeProjectRefinement.check, { message: scopeProjectRefinement.message });
export type SnippetGetInput = z.infer<typeof SnippetGetInput>;

export const SnippetListInput = z.object({
  project: ProjectKey.optional(),
  scope: MemoryScope.optional(),
  tags: z.array(z.string()).optional(),
  limit: z.number().int().min(1).max(200).default(50),
});
export type SnippetListInput = z.infer<typeof SnippetListInput>;

export const SnippetDeleteInput = z
  .object({
    name: SnippetName,
    scope: MemoryScope.optional(),
    project: ProjectKey.optional(),
  })
  .refine(scopeProjectRefinement.check, { message: scopeProjectRefinement.message });
export type SnippetDeleteInput = z.infer<typeof SnippetDeleteInput>;
