import {
  pgTable,
  pgEnum,
  uuid,
  text,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
  customType,
  vector,
  varchar,
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

// ---------- tables ----------

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // OIDC `sub` claim from Authentik — stable identifier for this user.
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
    name: varchar("name", { length: 200 }).notNull(),
    body: text("body").notNull(),
    description: text("description"),
    tags: textArray("tags").notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqueUserName: uniqueIndex("snippets_user_name_uq").on(t.userId, t.name),
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
export type AuditEntry = typeof auditLog.$inferSelect;
export type NewAuditEntry = typeof auditLog.$inferInsert;
