-- Snippets gain scope/project mirroring memories.
--
-- Phase 1 created `snippets` as a flat per-user table. To make snippets
-- behave like memories (user-scope = global, project-scope = tied to a
-- repo) we add the same three columns: scope, project_id, deleted_at.
--
-- Uniqueness of `name` is enforced WITHIN a scope:
--   - within (user_id) for user-scope rows
--   - within (user_id, project_id) for project-scope rows
-- Soft-deleted rows are excluded from uniqueness so a name can be reused
-- after deletion.

ALTER TABLE "snippets"
  ADD COLUMN "scope"      memory_scope NOT NULL DEFAULT 'user',
  ADD COLUMN "project_id" uuid REFERENCES "projects"("id") ON DELETE SET NULL,
  ADD COLUMN "deleted_at" timestamptz;

-- Scope/project_id consistency mirrors memories_scope_project_chk.
ALTER TABLE "snippets"
  ADD CONSTRAINT "snippets_scope_project_chk"
  CHECK (
    (scope = 'project' AND project_id IS NOT NULL)
    OR (scope = 'user' AND project_id IS NULL)
  );

-- Drop the old global per-user uniqueness; replace with two partial
-- unique indexes scoped to live (non-deleted) rows.
DROP INDEX IF EXISTS "snippets_user_name_uq";

CREATE UNIQUE INDEX "snippets_user_name_user_scope_uq"
  ON "snippets" ("user_id", "name")
  WHERE scope = 'user' AND deleted_at IS NULL;

CREATE UNIQUE INDEX "snippets_user_project_name_uq"
  ON "snippets" ("user_id", "project_id", "name")
  WHERE scope = 'project' AND deleted_at IS NULL;

CREATE INDEX "snippets_user_idx"    ON "snippets" ("user_id");
CREATE INDEX "snippets_project_idx" ON "snippets" ("project_id");
