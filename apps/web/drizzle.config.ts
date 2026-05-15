import type { Config } from "drizzle-kit";

export default {
  schema: "./lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://memory:memory@localhost:5432/memory",
  },
  strict: true,
  verbose: true,
} satisfies Config;
