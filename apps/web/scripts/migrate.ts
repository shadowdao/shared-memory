/**
 * Run pending SQL migrations from ./drizzle in lexical filename order.
 *
 * Lightweight runner — drizzle-kit's TS migrator doesn't handle the raw SQL
 * features we need (pgvector, generated columns), so we manage migration
 * state ourselves in `_migrations` and apply files as plain SQL.
 */
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Resolve the migrations directory. Try, in order:
//   1. $MIGRATIONS_DIR env override (explicit deploy-time control)
//   2. `<script>/drizzle`  — production: migrate.mjs sits alongside drizzle/
//   3. `<script>/../drizzle` — dev: scripts/migrate.ts has drizzle/ one up
function findMigrationsDir(): string {
  if (process.env.MIGRATIONS_DIR) return process.env.MIGRATIONS_DIR;
  const sibling = join(__dirname, "drizzle");
  if (existsSync(sibling)) return sibling;
  const parent = join(__dirname, "..", "drizzle");
  if (existsSync(parent)) return parent;
  throw new Error(
    `Couldn't locate migrations directory (tried ${sibling}, ${parent}). ` +
      `Set MIGRATIONS_DIR to override.`,
  );
}

const MIGRATIONS_DIR = findMigrationsDir();

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

    if (process.env.EMBEDDER_URL) {
      await backfillEmbeddings(sql);
    } else {
      console.log("EMBEDDER_URL not set — skipping embedding backfill.");
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * Backfill embedding column for any memory written before embeddings were
 * online. Idempotent: only touches rows where embedding IS NULL. Runs on
 * every migrator boot, so deploying Phase 2 — or recovering from an
 * embedder outage that left fresh rows unembedded — needs no manual step.
 */
async function backfillEmbeddings(sql: ReturnType<typeof postgres>) {
  const embedderUrl = process.env.EMBEDDER_URL!.replace(/\/$/, "");
  const BATCH = 32;

  // Wait for the embedder to report ready — its first boot has to download
  // and load the model, which can take 30–60s on a cold container.
  const waitDeadline = Date.now() + 180_000;
  for (;;) {
    try {
      const res = await fetch(`${embedderUrl}/health`);
      if (res.ok) {
        const body = (await res.json()) as { ready?: boolean };
        if (body.ready) break;
      }
    } catch {
      /* embedder not up yet */
    }
    if (Date.now() > waitDeadline) {
      throw new Error("embedder did not become ready within 180s");
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  let total = 0;
  for (;;) {
    const rows = await sql<{ id: string; content: string }[]>`
      SELECT id, content FROM memories
      WHERE embedding IS NULL AND deleted_at IS NULL
      ORDER BY created_at
      LIMIT ${BATCH}
    `;
    if (rows.length === 0) break;

    const res = await fetch(`${embedderUrl}/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ texts: rows.map((r) => r.content) }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`embedder error ${res.status}: ${detail.slice(0, 200)}`);
    }
    const { vectors } = (await res.json()) as { vectors: number[][] };

    await sql.begin(async (tx) => {
      for (let i = 0; i < rows.length; i++) {
        const id = rows[i]!.id;
        const vec = vectors[i];
        if (!vec) continue;
        const literal = `[${vec.join(",")}]`;
        await tx`UPDATE memories SET embedding = ${literal}::vector WHERE id = ${id}`;
      }
    });

    total += rows.length;
    console.log(`  embedded ${rows.length} memories (total: ${total})`);
  }

  if (total === 0) {
    console.log("Embedding backfill: nothing to do.");
  } else {
    console.log(`Embedding backfill complete: ${total} memories embedded.`);
  }
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
