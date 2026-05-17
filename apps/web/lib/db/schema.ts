import {
  pgTable,
  pgEnum,
  uuid,
  text,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
  primaryKey,
  customType,
  vector,
  varchar,
  integer,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ---------- custom column types ----------

// Postgres tsvector — generated server-side from `content`, not written by app.
const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return "tsvector";
  },
});

// Text array helper (Drizzle's `.array()` works, but this keeps intent explicit).
const textArray = customType<{ data: string[]; driverData: string }>({
  dataType() {
    return "text[]";
  },
  toDriver(value) {
    return `{${value.map((v) => `"${v.replace(/"/g, '\\"')}"`).join(",")}}`;
  },
});

// ---------- enums ----------

export const memoryScope = pgEnum("memory_scope", ["project", "user"]);
export const memoryVisibility = pgEnum("memory_visibility", ["private", "shared", "team"]);
export const auditActor = pgEnum("audit_actor", ["mcp", "web", "system"]);
// Created by 0003_groups.sql; declared here so the TS layer (notably
// `project_shares`) can reference it as a typed pgEnum.
export const memoryAccess = pgEnum("memory_access", ["ro", "rw"]);

// ---------- tables ----------

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // OIDC `sub` claim from the IdP — stable identifier for this user.
    oidcSub: text("oidc_sub").notNull(),
    // OIDC `iss` so we can disambiguate if we ever federate.
    oidcIss: text("oidc_iss").notNull(),
    email: text("email"),
    name: text("name"),
    picture: text("picture"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqueIss: uniqueIndex("users_iss_sub_uq").on(t.oidcIss, t.oidcSub),
  }),
);

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Caller-supplied stable identifier (e.g. repo name or any string).
    key: varchar("key", { length: 200 }).notNull(),
    displayName: text("display_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqueUserKey: uniqueIndex("projects_user_key_uq").on(t.userId, t.key),
  }),
);

export const memories = pgTable(
  "memories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // NULL when scope = 'user' (global to the user across all projects).
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    scope: memoryScope("scope").notNull().default("project"),
    visibility: memoryVisibility("visibility").notNull().default("private"),
    content: text("content").notNull(),
    tags: textArray("tags").notNull().default([]),
    // Populated by Phase 2 once the embedder sidecar is online; NULL in Phase 1.
    embedding: vector("embedding", { dimensions: 384 }),
    // Generated column — see migration SQL for definition.
    contentTsv: tsvector("content_tsv"),
    // Optimistic-locking counter. Bumped on every successful UPDATE so
    // concurrent edits (now possible across shared-project members) can
    // detect lost-write situations and surface "refresh and try again".
    version: integer("version").notNull().default(1),
    // The user whose UPDATE most recently mutated this row. NULL only on
    // the very first INSERT (pre-update). FK is `SET NULL` so deleting
    // an account doesn't wipe other people's memories.
    lastEditedBy: uuid("last_edited_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    userIdx: index("memories_user_idx").on(t.userId),
    projectIdx: index("memories_project_idx").on(t.projectId),
    createdIdx: index("memories_created_idx").on(t.createdAt),
    // Vector index, tsvector index, and trigram index for tags are declared
    // in the SQL migration since drizzle-kit doesn't model them.
  }),
);

export const snippets = pgTable(
  "snippets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // NULL when scope = 'user' (global to the user). Mirrors `memories`.
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    scope: memoryScope("scope").notNull().default("user"),
    name: varchar("name", { length: 200 }).notNull(),
    body: text("body").notNull(),
    description: text("description"),
    tags: textArray("tags").notNull().default([]),
    // See `memories.version` / `memories.lastEditedBy` — co-edit primitive
    // for snippets in shared projects.
    version: integer("version").notNull().default(1),
    lastEditedBy: uuid("last_edited_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    userIdx: index("snippets_user_idx").on(t.userId),
    projectIdx: index("snippets_project_idx").on(t.projectId),
    // Partial unique indexes (one per scope, live rows only) are declared
    // in the SQL migration since drizzle-kit doesn't model partial indexes.
  }),
);

export const cliTokens = pgTable(
  "cli_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    jti: text("jti").notNull().unique(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => ({
    userIdx: index("cli_tokens_user_idx").on(t.userId),
  }),
);

// ---------- groups + sharing ----------
//
// `groups` and `user_groups` come from `0003_groups.sql`; `project_shares`
// comes from `0004_project_shares.sql`. Drizzle declarations here let
// authorization helpers and the share-management UI import everything
// through `@/lib/db/schema`. Column shape MUST stay in lockstep with the
// migrations.

export const groups = pgTable(
  "groups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // OIDC issuer this group originates from — pairs with `name` so two
    // IdPs can both have a "platform" group without collision.
    oidcIss: text("oidc_iss").notNull(),
    // Group `name` as it appears in the JWT (Authentik / EntraID groups claim).
    name: text("name").notNull(),
    displayName: text("display_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqueIssName: uniqueIndex("groups_iss_name_uq").on(t.oidcIss, t.name),
  }),
);

export const userGroups = pgTable(
  "user_groups",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    groupId: uuid("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    // Refreshed on every sign-in that re-observes this membership.
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.groupId] }),
    userIdx: index("user_groups_user_idx").on(t.userId),
    groupIdx: index("user_groups_group_idx").on(t.groupId),
  }),
);

// `project_shares` grants a `group` access to a `project`. Each row
// authorizes every user in that group to read (and, when access='rw',
// write) every memory + snippet under that project.
//
// Owners share projects from the Web UI; the MCP layer can resolve
// shared projects via project.identify but cannot grant new shares.
export const projectShares = pgTable(
  "project_shares",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    groupId: uuid("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    access: memoryAccess("access").notNull(),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
    // Audit-friendly. `SET NULL` so deleting the granter's account doesn't
    // cascade-remove the share.
    grantedBy: uuid("granted_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.projectId, t.groupId] }),
    groupIdx: index("project_shares_group_idx").on(t.groupId),
  }),
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    actor: auditActor("actor").notNull(),
    action: text("action").notNull(),
    entityType: text("entity_type"),
    entityId: uuid("entity_id"),
    payload: jsonb("payload"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index("audit_user_idx").on(t.userId),
    createdIdx: index("audit_created_idx").on(t.createdAt),
  }),
);

// Re-export sql helper so callers can compose raw fragments without a
// second drizzle import.
export { sql };

// ---------- inferred types ----------

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type Memory = typeof memories.$inferSelect;
export type NewMemory = typeof memories.$inferInsert;
export type Snippet = typeof snippets.$inferSelect;
export type NewSnippet = typeof snippets.$inferInsert;
export type CliToken = typeof cliTokens.$inferSelect;
export type NewCliToken = typeof cliTokens.$inferInsert;
export type AuditEntry = typeof auditLog.$inferSelect;
export type NewAuditEntry = typeof auditLog.$inferInsert;
export type Group = typeof groups.$inferSelect;
export type NewGroup = typeof groups.$inferInsert;
export type UserGroup = typeof userGroups.$inferSelect;
export type NewUserGroup = typeof userGroups.$inferInsert;
export type ProjectShare = typeof projectShares.$inferSelect;
export type NewProjectShare = typeof projectShares.$inferInsert;
