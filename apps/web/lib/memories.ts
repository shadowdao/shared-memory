import { and, eq, inArray } from "drizzle-orm";
import { db, pg } from "@/lib/db/client";
import { projects } from "@/lib/db/schema";
import { embedText } from "@/lib/embedder";
import { readableProjectIds } from "@/lib/access";

/**
 * Shared search helper. Used by:
 *   - the MCP `memory.search` tool (returns rich rank data for the model)
 *   - the Web UI memories page (renders human-readable results)
 *
 * Performs three candidate fetches in parallel — pgvector cosine, FTS
 * ts_rank_cd, tag-set overlap — then fuses with Reciprocal Rank Fusion
 * (k=60). Returns top-N with per-source rank info attached.
 *
 * Sharing model: a user can see memories they OWN (user_id = U) plus
 * project-scope memories under any project that's been shared with one
 * of their groups (any access — ro is enough to read). The three CTEs
 * extend their WHERE clauses accordingly.
 */

export interface SearchFilters {
  scope?: "project" | "user";
  projectKey?: string;
  tags?: string[];
  /**
   * Group names the requesting user is a member of. Drives shared-
   * project visibility. An undefined value is treated as `[]` (no
   * shared visibility) — pass through `UserContext.groups`.
   */
  groupNames?: string[];
}

export interface SearchHit {
  id: string;
  rank: {
    rrfScore: number;
    vectorRank: number | null;
    ftsRank: number | null;
    tagRank: number | null;
  };
}

export interface SearchResult {
  hits: SearchHit[];
  debug: { vec: number; fts: number; tag: number };
}

const CANDIDATES = 50;
const RRF_K = 60;

function toVectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}

async function resolveProjectIdForKey(
  userId: string,
  groupNames: string[],
  projectKey: string,
): Promise<string | null> {
  // First check owned. Owned wins on key collision (matches
  // project.identify's priority).
  const owned = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.userId, userId), eq(projects.key, projectKey)))
    .limit(1);
  if (owned[0]) return owned[0].id;

  if (groupNames.length === 0) return null;

  // Then any shared project with that key. The user is allowed to read
  // it; per-project authorization is enforced by the calling code's IN
  // clause against `accessibleIds`.
  const accessibleIds = await readableProjectIds(userId, groupNames);
  if (accessibleIds.length === 0) return null;
  const shared = await db
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(
        eq(projects.key, projectKey),
        inArray(projects.id, accessibleIds),
      ),
    )
    .limit(1);
  return shared[0]?.id ?? null;
}

export async function searchMemories(
  userId: string,
  query: string,
  filters: SearchFilters = {},
  limit = 20,
): Promise<SearchResult> {
  const { scope, projectKey, tags, groupNames = [] } = filters;
  const projectId = projectKey
    ? await resolveProjectIdForKey(userId, groupNames, projectKey)
    : null;
  if (projectKey && !projectId) {
    return { hits: [], debug: { vec: 0, fts: 0, tag: 0 } };
  }

  const queryVec = await embedText(query);
  const vecLit = toVectorLiteral(queryVec);

  // Build the user-visibility fragment once: rows the caller owns OR
  // rows whose project_id is in the set of projects shared with this
  // user's groups. When `projectId` is set we've already authorized
  // that single project and can drop the fragment.
  const accessibleProjectIds = projectId
    ? null
    : await readableProjectIds(userId, groupNames);

  // postgres-js's `${array}::uuid[]` interpolates as a Postgres array
  // literal automatically. Empty array works: `= ANY('{}')` is false,
  // which is the right behaviour for "no projects accessible".
  const visibilityFragment = projectId
    ? pg`AND project_id = ${projectId}`
    : pg`AND (user_id = ${userId} OR project_id = ANY(${accessibleProjectIds ?? []}::uuid[]))`;

  const vecPromise = pg<{ id: string }[]>`
    SELECT id
    FROM memories
    WHERE deleted_at IS NULL
      AND embedding IS NOT NULL
      ${scope ? pg`AND scope = ${scope}` : pg``}
      ${visibilityFragment}
    ORDER BY embedding <=> ${vecLit}::vector ASC
    LIMIT ${CANDIDATES}
  `;

  const ftsPromise = pg<{ id: string }[]>`
    SELECT id
    FROM memories, plainto_tsquery('english', ${query}) AS q
    WHERE deleted_at IS NULL
      AND content_tsv @@ q
      ${scope ? pg`AND scope = ${scope}` : pg``}
      ${visibilityFragment}
    ORDER BY ts_rank_cd(content_tsv, q) DESC
    LIMIT ${CANDIDATES}
  `;

  const tagPromise =
    tags && tags.length > 0
      ? pg<{ id: string }[]>`
          SELECT id
          FROM memories
          WHERE deleted_at IS NULL
            AND tags && ${tags}::text[]
            ${scope ? pg`AND scope = ${scope}` : pg``}
            ${visibilityFragment}
          ORDER BY cardinality(
            ARRAY(SELECT unnest(tags) INTERSECT SELECT unnest(${tags}::text[]))
          ) DESC
          LIMIT ${CANDIDATES}
        `
      : Promise.resolve([] as { id: string }[]);

  const [vec, fts, tag] = await Promise.all([vecPromise, ftsPromise, tagPromise]);

  interface Accumulator {
    vectorRank: number | null;
    ftsRank: number | null;
    tagRank: number | null;
    rrfScore: number;
  }
  const scores = new Map<string, Accumulator>();
  const accum = (id: string, rank: number, key: "vectorRank" | "ftsRank" | "tagRank") => {
    const e =
      scores.get(id) ??
      ({ vectorRank: null, ftsRank: null, tagRank: null, rrfScore: 0 } as Accumulator);
    e[key] = rank;
    e.rrfScore += 1 / (RRF_K + rank);
    scores.set(id, e);
  };
  vec.forEach((h, i) => accum(h.id, i + 1, "vectorRank"));
  fts.forEach((h, i) => accum(h.id, i + 1, "ftsRank"));
  tag.forEach((h, i) => accum(h.id, i + 1, "tagRank"));

  const hits = [...scores.entries()]
    .sort(([, a], [, b]) => b.rrfScore - a.rrfScore)
    .slice(0, limit)
    .map(([id, rank]) => ({
      id,
      rank: {
        rrfScore: Number(rank.rrfScore.toFixed(6)),
        vectorRank: rank.vectorRank,
        ftsRank: rank.ftsRank,
        tagRank: rank.tagRank,
      },
    }));

  return { hits, debug: { vec: vec.length, fts: fts.length, tag: tag.length } };
}
