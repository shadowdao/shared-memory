-- Initial migration for shared-memory.
-- Sets up extensions, enum types, tables, generated columns, and indexes
-- required for memory storage + hybrid search (Phase 2 populates the
-- embedding column; FTS works in Phase 1).

-- =============================================================================
-- Extensions
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "vector";     -- pgvector
CREATE EXTENSION IF NOT EXISTS "pg_trgm";    -- trigram index for tag fuzzy match

-- =============================================================================
-- Enums
-- =============================================================================

CREATE TYPE "memory_scope" AS ENUM ('project', 'user');
CREATE TYPE "memory_visibility" AS ENUM ('private', 'shared', 'team');
CREATE TYPE "audit_actor" AS ENUM ('mcp', 'web', 'system');

-- =============================================================================
-- users
-- =============================================================================

CREATE TABLE "users" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "oidc_sub"      text NOT NULL,
  "oidc_iss"      text NOT NULL,
  "email"         text,
  "name"          text,
  "picture"       text,
  "created_at"    timestamptz NOT NULL DEFAULT now(),
  "last_seen_at"  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "users_iss_sub_uq" ON "users" ("oidc_iss", "oidc_sub");

-- =============================================================================
-- projects
-- =============================================================================

CREATE TABLE "projects" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"       uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "key"           varchar(200) NOT NULL,
  "display_name"  text,
  "created_at"    timestamptz NOT NULL DEFAULT now(),
  "updated_at"    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "projects_user_key_uq" ON "projects" ("user_id", "key");

-- =============================================================================
-- memories
-- =============================================================================

CREATE TABLE "memories" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"     uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "project_id"  uuid REFERENCES "projects"("id") ON DELETE SET NULL,
  "scope"       memory_scope NOT NULL DEFAULT 'project',
  "visibility"  memory_visibility NOT NULL DEFAULT 'private',
  "content"     text NOT NULL,
  "tags"        text[] NOT NULL DEFAULT ARRAY[]::text[],
  "embedding"   vector(384),
  "content_tsv" tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce("content", ''))) STORED,
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  "updated_at"  timestamptz NOT NULL DEFAULT now(),
  "deleted_at"  timestamptz,
  -- Scope/project_id consistency: project scope requires a project_id,
  -- user scope forbids one.
  CONSTRAINT "memories_scope_project_chk"
    CHECK (
      (scope = 'project' AND project_id IS NOT NULL)
      OR (scope = 'user' AND project_id IS NULL)
    )
);

CREATE INDEX "memories_user_idx"    ON "memories" ("user_id");
CREATE INDEX "memories_project_idx" ON "memories" ("project_id");
CREATE INDEX "memories_created_idx" ON "memories" ("created_at" DESC);

-- GIN index for full-text search over the generated tsvector column.
CREATE INDEX "memories_content_tsv_idx" ON "memories" USING GIN ("content_tsv");

-- GIN index on tags for tag-set containment queries (`tags @> ARRAY[...]`).
-- pg_trgm is loaded for future fuzzy text search on `content`, not tags.
CREATE INDEX "memories_tags_idx" ON "memories" USING GIN ("tags");

-- IVFFlat vector index. Lists=100 is a reasonable starting point; tune later
-- once we have real volume. Note: the index requires data to be useful — it's
-- created here so embeddings written in Phase 2 are indexed automatically.
CREATE INDEX "memories_embedding_idx" ON "memories"
  USING ivfflat ("embedding" vector_cosine_ops) WITH (lists = 100);

-- =============================================================================
-- snippets
-- =============================================================================

CREATE TABLE "snippets" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"      uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "name"         varchar(200) NOT NULL,
  "body"         text NOT NULL,
  "description"  text,
  "tags"         text[] NOT NULL DEFAULT ARRAY[]::text[],
  "created_at"   timestamptz NOT NULL DEFAULT now(),
  "updated_at"   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "snippets_user_name_uq" ON "snippets" ("user_id", "name");
CREATE INDEX "snippets_tags_idx" ON "snippets" USING GIN ("tags");

-- =============================================================================
-- audit_log
-- =============================================================================

CREATE TABLE "audit_log" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"     uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "actor"       audit_actor NOT NULL,
  "action"      text NOT NULL,
  "entity_type" text,
  "entity_id"   uuid,
  "payload"     jsonb,
  "created_at"  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX "audit_user_idx"    ON "audit_log" ("user_id");
CREATE INDEX "audit_created_idx" ON "audit_log" ("created_at" DESC);

-- =============================================================================
-- updated_at triggers
-- =============================================================================

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER projects_set_updated_at BEFORE UPDATE ON "projects"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER memories_set_updated_at BEFORE UPDATE ON "memories"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER snippets_set_updated_at BEFORE UPDATE ON "snippets"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
