-- Phase 4c+d+e: project sharing + optimistic-locking version columns.
--
-- Depends on Agent A's `0003_groups.sql`, which introduces:
--   - `groups` table (id, oidc_iss, name, …)
--   - `user_groups` membership table
--   - `memory_access` enum ('ro', 'rw')
--
-- This migration is the sharing layer on top of those foundations plus
-- the co-edit primitives that make multi-user editing safe.

-- =============================================================================
-- project_shares: grants a group access to a project
-- =============================================================================
--
-- One row per (project, group) pair. Access level controls whether
-- members of the group can mutate rows under that project (rw) or only
-- observe them (ro). Owners (projects.user_id = users.id) always retain
-- full control regardless of any project_shares rows.
--
-- granted_by is informational — `SET NULL` on user delete so the share
-- itself outlives the granter's account.

CREATE TABLE "project_shares" (
  "project_id"  uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "group_id"    uuid NOT NULL REFERENCES "groups"("id")   ON DELETE CASCADE,
  "access"      memory_access NOT NULL,
  "granted_at"  timestamptz   NOT NULL DEFAULT now(),
  "granted_by"  uuid REFERENCES "users"("id") ON DELETE SET NULL,
  PRIMARY KEY ("project_id", "group_id")
);

-- Lookups go in both directions: "what's shared with group G" (used when
-- resolving a user's accessible projects via their group memberships) and
-- "who has access to project P" (used on the project detail page).
-- The primary key already covers the second; this index covers the first.
CREATE INDEX "project_shares_group_idx" ON "project_shares" ("group_id");

-- =============================================================================
-- memories.version + memories.last_edited_by
-- =============================================================================
--
-- `version` starts at 1 on insert and is bumped by every UPDATE. Edit
-- forms and MCP `memory.update` pass the version they observed; the
-- UPDATE's WHERE clause includes `AND version = $version`, so a stale
-- caller gets 0 rows updated and we surface a "refresh and try again"
-- error rather than clobber a concurrent edit.
--
-- `last_edited_by` records who performed the most recent UPDATE.

ALTER TABLE "memories"
  ADD COLUMN "version"        integer NOT NULL DEFAULT 1,
  ADD COLUMN "last_edited_by" uuid REFERENCES "users"("id") ON DELETE SET NULL;

-- =============================================================================
-- snippets.version + snippets.last_edited_by
-- =============================================================================
--
-- Same shape and rationale as memories. Co-editable snippets live in
-- shared projects; user-scope snippets remain single-author in practice
-- but the columns are uniform across both scopes for simplicity.

ALTER TABLE "snippets"
  ADD COLUMN "version"        integer NOT NULL DEFAULT 1,
  ADD COLUMN "last_edited_by" uuid REFERENCES "users"("id") ON DELETE SET NULL;
