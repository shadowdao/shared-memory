import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "@/lib/env";
import * as schema from "./schema";

// Reuse a single connection pool across hot reloads in dev.
type GlobalWithPg = typeof globalThis & {
  __sharedMemoryPg?: ReturnType<typeof postgres>;
};
const g = globalThis as GlobalWithPg;

function makePool() {
  return postgres(env().DATABASE_URL, {
    max: 10,
    idle_timeout: 30,
    connect_timeout: 10,
    prepare: false,
  });
}

const sql = g.__sharedMemoryPg ?? makePool();
if (process.env.NODE_ENV !== "production") g.__sharedMemoryPg = sql;

export const db = drizzle(sql, { schema, logger: env().LOG_LEVEL === "debug" });
export { sql as pg, schema };
