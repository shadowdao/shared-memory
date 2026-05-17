-- Groups + per-user group memberships, plus the `memory_access` enum.
--
-- This migration is the substrate for the upcoming group-scoped sharing
-- feature (project_shares). It owns:
--
--   * memory_access enum  — reserved for project_shares to reference.
--   * groups table        — one row per distinct group seen in any user's
--                            OIDC `groups` claim, keyed by (oidc_iss, name)
--                            so different IdPs can both have a group called
--                            e.g. "platform" without colliding.
--   * user_groups table   — current group memberships for each user. Synced
--                            on every sign-in: rows are inserted/deleted to
--                            mirror the freshly-issued claim, so IdP
--                            membership changes propagate at next login.
--
-- We deliberately do NOT add project_shares here — that's Agent B's 0004.
-- Defining the enum in 0003 lets 0004 reference it without sequencing
-- gymnastics.

-- =============================================================================
-- Enums
-- =============================================================================

CREATE TYPE "memory_access" AS ENUM ('ro', 'rw');

-- =============================================================================
-- groups
-- =============================================================================

CREATE TABLE "groups" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- OIDC issuer this group's identity comes from. Pairs with `name` to
  -- form the natural key — same group name in two IdPs are distinct rows.
  "oidc_iss"     text NOT NULL,
  -- The group name as it appears in the OIDC `groups` claim.
  "name"         text NOT NULL,
  -- Optional human-friendly label. Most IdPs only emit names so this is
  -- typically NULL; reserved for future enrichment.
  "display_name" text,
  "created_at"   timestamptz NOT NULL DEFAULT now(),
  "updated_at"   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "groups_iss_name_uq" ON "groups" ("oidc_iss", "name");

CREATE TRIGGER groups_set_updated_at BEFORE UPDATE ON "groups"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================================
-- user_groups
-- =============================================================================

CREATE TABLE "user_groups" (
  "user_id"    uuid NOT NULL REFERENCES "users"("id")  ON DELETE CASCADE,
  "group_id"   uuid NOT NULL REFERENCES "groups"("id") ON DELETE CASCADE,
  -- When this membership was last observed in a sign-in claim. The auth
  -- callback rewrites this on every login (insert ... on conflict do
  -- update) so it's effectively "last sign-in seen this membership".
  "synced_at"  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("user_id", "group_id")
);

CREATE INDEX "user_groups_user_idx" ON "user_groups" ("user_id");
