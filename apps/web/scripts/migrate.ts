/**
 * Run pending SQL migrations from ./drizzle in lexical filename order.
 *
 * Lightweight runner — drizzle-kit's TS migrator doesn't handle the raw SQL
 * features we need (pgvector, generated columns), so we manage migration
 * state ourselves in `_migrations` and apply files as plain SQL.
 */
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "..", "drizzle");

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }

  const sql = postgres(url, { max: 1, prepare: false });

  try {
    await sql`
      CREATE TABLE IF NOT EXISTS "_migrations" (
        "id"          serial PRIMARY KEY,
        "name"        text NOT NULL UNIQUE,
        "applied_at"  timestamptz NOT NULL DEFAULT now()
      )
    `;

    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith(".sql"))
      .sort();

    const applied = new Set(
      (await sql<{ name: string }[]>`SELECT name FROM "_migrations"`).map((r) => r.name),
    );

    for (const file of files) {
      if (applied.has(file)) {
        console.log(`✓ ${file} (already applied)`);
        continue;
      }
      const body = await readFile(join(MIGRATIONS_DIR, file), "utf8");
      console.log(`→ ${file} (applying)`);
      await sql.begin(async (tx) => {
        await tx.unsafe(body);
        await tx`INSERT INTO "_migrations" (name) VALUES (${file})`;
      });
      console.log(`✓ ${file}`);
    }

    console.log("Migrations complete.");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
