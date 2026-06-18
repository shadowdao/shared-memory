# CLAUDE.md — shared-memory

Project key (for the shared-memory MCP): `shared-memory` (set by the `.shared-memory-project` marker at the repo root).

## Consulting memory before substantive work

There are TWO memory stores. The file-based memory (`MEMORY.md` + topic files) is auto-loaded into context every session. The **shared-memory MCP** (`mcp__shared-memory__*`) is NOT auto-loaded — you must query it. Query on demand when you need detail; do not bulk-load everything (that wastes context).

When a request draws on accumulated project knowledge — an architecture/development overview, debugging, planning, reviewing, or implementing a feature, or any question about how the system works — do this BEFORE answering or acting:

1. Use what's already in the auto-loaded `MEMORY.md` index.
2. ALSO check the shared-memory MCP: call `project_identify` once per session (resolves the key from `.shared-memory-project`), then `memory_search` with the task topic in natural language (a couple of queries if the task spans areas). Fetch full bodies with `memory_get` when a hit looks relevant.
3. Fold both sources into your answer; note when something came from saved memory.

## Reusing saved snippets (boilerplate / templates) before recreating work

Snippets (`mcp__shared-memory__snippet_*`) hold reusable artifacts — boilerplate, standard formats, checklists, established workflows. They are pull-only and, unlike memory, **NOT searchable**: `snippet_get` fetches by EXACT name, and the `description` shown by `snippet_list` is the ONLY discovery surface (tags are just for human browsing).

Before hand-writing standard/boilerplate code or re-deriving a known workflow, check whether a template already exists:

1. Call `snippet_list` once — it's cheap: it returns names + descriptions + tags, **no bodies**. Scan the descriptions for a match.
2. If one fits, `snippet_get <name>` to pull just that body and apply it, instead of recreating it from scratch.
3. When you produce a reusable artifact worth keeping, save it with `snippet_put` under a stable, predictable name (e.g. `boilerplate/<area>/<thing>`) and a concrete "when to use" `description` so a future agent can find it by scanning `snippet_list`.

Skip both checks only for trivial, self-contained requests (a quick edit, a one-off shell command, casual conversation) where prior project context can't matter. If the MCP server isn't connected in this session, proceed with file memory and say so.
