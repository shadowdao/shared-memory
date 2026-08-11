# Decision record: memory read payloads and patch-style updates

**Status:** P1 shipped · P2 shipped · P3 declined
**Originated:** 2026-08-11, from live use of the deployed server
**Revised:** 2026-08-11, against source
**Closed:** 2026-08-11 — implemented in `feat/memory-patch-and-lean-get` (PR #19)

This started as a proposal written from black-box observation of the deployed
server. It is kept as a decision record because the reasoning behind what was
built — and behind what was deliberately *not* built — is not recoverable from
the diff.

---

## 0. Orientation

Tools are defined internally with dots (`memory.get`) and surfaced to clients
with underscores (`memory_get`). Don't let it confuse a grep.

### Data model

- Memories have `id` (uuid), `content`, `tags[]`, `scope` (`project` | `user`),
  `projectId`, `visibility`, `version`, `lastEditedBy`, `createdAt`,
  `updatedAt`, `deletedAt`, plus `userId`, `embedding`, and `contentTsv`
  (`apps/web/lib/db/schema.ts`).
- `scope: project` requires `project`; `scope: user` requires it omitted.
- `version` is an optimistic-locking token, bumped on every successful update.
  A stale `version` returns a concurrent-edit error.
- Content limit is 64,000 chars (`packages/schemas/src/index.ts`).
- Shared projects allow anyone with rw access to edit any memory — hence the
  locking.

---

## 1. P1 — `memory_get` returned the embedding and the tsvector ✅ SHIPPED

**Problem.** `memory_get` used a bare `select()` and returned the raw DB row,
including the `embedding` vector and the `contentTsv` lexeme index. Both are
Postgres retrieval internals with zero value to a model consumer.
`memory_list` and `memory_search` already projected an explicit 9-field shape —
`memory_get` was the only outlier.

**Measured against the live server** on a ~13k-char memory:

| | chars | share |
|---|---|---|
| `content` | 27,662 | 44.1% |
| `contentTsv` | 29,912 | 47.7% |
| `embedding` | 4,688 | 7.5% |
| other 12 fields | 433 | 0.7% |
| **total** | **62,695** | |

Two distinct failure shapes, which the original draft had flattened together:

- `embedding` is a **fixed** ~4,690-char tax on every read — 384 dims
  regardless of content length. Nearly invisible on large memories (7.5%),
  dominant on small ones (~58% of an ~8k response). Most memories are small.
- `contentTsv` scales **super-linearly** with content (frequent lexemes
  accumulate long position lists, ~21 chars/entry) and was the largest single
  component of the large payload — larger than the content itself.

**This was a correctness problem, not an efficiency nit.** Fetching that memory
exceeded the MCP tool-output cap and spilled to a file, even though `content`
alone is comfortably under the limit. `memory_get` was unusable on exactly the
large living documents P2 exists to serve. At the 64,000-char content ceiling a
response would land near 140,000 characters, under half of it content.

**Shipped:** `memory_get` returns the same 9 fields as `memory_list` /
`memory_search`. `userId` is still selected for the authorization check and
stripped before responding.

**Rejected: an `include: ("embedding" | "tsv")[]` opt-in.** The original draft
proposed gating the fields behind a flag in case some caller needed them. No
caller can: no MCP client can consume a 384-float vector or a lexeme index, and
the Web UI never goes through the MCP tools (it reads via `lib/memories.ts` and
writes via `lib/memory-actions.ts`). The parameter would have been dead on
arrival.

---

## 2. P2 — patch-style updates ✅ SHIPPED

**Problem.** `memory_update` accepted only full replacement. Adding four lines
to a 13,000-char living document meant reproducing the entire document.

**The evidence this was a real blocker.** The WHP roadmap mirror was three
weeks and two shipped releases out of date. The agent that noticed **declined
to fix it**, on the grounds that hand-reproducing 13k characters of shared team
history to add one entry risked silently dropping some of it — a worse outcome
than leaving it stale.

That is the failure mode this was designed against: **when the only safe way to
make a small edit is expensive, the edit doesn't happen.**

**Shipped:** `memory_patch(id, old_string, new_string, version?)`

| condition | behaviour |
|---|---|
| `old_string` absent | error — never a silent no-op |
| `old_string` matches >1 | error naming the count — ambiguity never resolves arbitrarily |
| matches exactly once | replace, bump `version`, re-embed |
| stale `version` | concurrent-edit error |

Both failure modes refuse rather than clobber. That is the property that makes
the operation safe to hand to an agent editing a shared document it cannot
afford to corrupt. Semantics live in `lib/memory-patch.ts` as a pure function,
free of DB and auth, so both surfaces share them.

**Locking came nearly free.** `memory.update` already computed
`expectedVersion = version ?? existing.version`, falling back to the version
read in the same handler. The CAS therefore already guarded the server-side
read-modify-write; patch copies that shape and is race-safe even when the
caller omits `version`. No explicit transaction was required.

**Rejected: `memory_append` with a `section` parameter.** Proposed as sugar for
heading-structured logs. Patch already covers that case exactly —
`memory_patch(id, "## RECENTLY SHIPPED", "## RECENTLY SHIPPED\n- entry")` — and
does so *with* the uniqueness guarantee: if the heading appears twice you get an
error instead of an arbitrary insert. Implementing `section` would have meant
defining heading-match semantics, insert position within a section, and
duplicate-heading behaviour, for something patch handles for free.

---

## 3. P3 — deriving mirrors rather than relying on convention ❌ DECLINED

**The problem as stated.** Some memories mirror local files. The sync is
enforced only by a note in the file's own header: *"MIRRORED to shared-memory
MCP … when you update this file, also `memory_update` that record."* That
depends on whoever edits the file noticing the note and performing a second
write. It went three weeks without one.

Proposed shapes were: a server-side `memory_sync_from_file`, a staleness signal
via `sourcePath` + content hash, or leaving it manual but cheap via P2.

**Declined, 2026-08-11.** Three reasons, in order of weight:

1. **The cause we have evidence for is now fixed.** The evidence was specific:
   an agent *noticed* the drift and *declined* to fix it because the edit was
   expensive and risky. That is a cost failure, not an attention failure. P2
   makes that edit a single call. We have direct evidence for the cost cause
   and none yet for any other.

2. **It would likely be a mechanism for N=1.** One mirror is known to exist.
   A `sourcePath` column, hash computation, and staleness plumbing is real
   schema-and-sync work; building it to police a single document is
   disproportionate.

3. **If drift recurs, the better fix probably isn't sync machinery.** P3
   assumes the mirror should exist and be kept honest. That assumption deserves
   scrutiny first: the memory is a condensed prose rendition of a file that
   lives in a container, existing separately only because the memory is
   cross-machine and the file is not. Two hand-maintained sources of truth plus
   a drift detector is strictly more machinery than one source of truth. The
   cheaper answer would be to remove the duplication — make the memory
   canonical and drop the file, or generate one from the other.

**What would reopen this:** the roadmap going stale *again* now that patching
is cheap. That is the clean experiment and it costs nothing to run. If it
drifts again, the cause was attention rather than cost, and option 2 above — a
staleness signal that makes drift *visible* rather than trying to fix it
automatically — becomes worth its weight.

Note for whoever picks this up: the mirror is **not** a byte copy of its local
file. It is a condensed prose rendition with different headings and no
wiki-links. A naive file-sync would destroy its established form. Any solution
has to preserve that distinction or deliberately abandon it.

---

## 4. Structural work this depended on ✅ SHIPPED

Neither of these was in the original proposal; both were found once the source
was available.

### 4.1 The write path was duplicated

`updateMemoryAction` (Web UI) and the `memory.update` MCP handler each
reimplemented authorize → mutate → re-embed → CAS → audit. Neither delegated to
a shared helper, and they had **drifted**: `memory.delete` over MCP skipped the
project ACL whenever the caller authored the row, so a memory written while a
share was `rw` stayed deletable by its author after an owner downgraded that
share to `ro`. `memory.update` and the entire Web UI always checked.

Both surfaces now route through `lib/memory-mutations.ts`. Authoring a row
grants no standing write privilege on any path — the project ACL is the
authority, not the byline. This was a behaviour change, shipped deliberately,
and is covered by a test that fails against the old code.

The one genuine difference between the surfaces is injected as a
`ProjectResolver`: MCP refuses an unknown project key (`call project.identify
first`) so an agent cannot spawn near-miss projects off a typo, while the Web
UI creates one, because a person typing a name into a form means to.

### 4.2 There was no test infrastructure

No vitest, no jest, no test files, no `test` script. Added vitest, with
integration tests running against a real Postgres rather than a mocked DB.
Setup is documented in the README.

---

## 5. Invariants — preserve these

- **Optimistic locking.** `version` must keep working, and every new mutating
  primitive must accept it. Shared projects have concurrent editors.
- **Scope/project rules.** `scope: project` ⇒ `project` required and must
  already exist on the MCP path; `scope: user` ⇒ `project` omitted.
- **Re-embedding on content change — and note what this does NOT cover.**
  `content_tsv` is `GENERATED ALWAYS AS (to_tsvector('english',
  coalesce(content, ''))) STORED` (`apps/web/drizzle/0000_init.sql`), so
  Postgres maintains it and **full-text search cannot rot**. Only `embedding`
  requires an explicit recompute. Any new mutation path must re-embed, or
  *semantic* retrieval degrades silently while FTS keeps working — which is
  exactly what makes the failure hard to notice.
- **Stable `id` across edits.** Never implement an edit as delete + recreate.
- **64,000-char content limit** enforced after a patch is applied, not just on
  the incoming fragment.
- **Audit trail.** Partial edits record match offset and length delta, not just
  the changed field names.

---

## 6. Acceptance checks

**P1** — verified in tests; the payload figures need a deploy to confirm.
- ✅ Response contains neither `embedding` nor `contentTsv`.
- ✅ Field set matches `memory_list` / `memory_search` exactly (9, down from 14).
- ⏳ Large specimen drops 62,695 → ~28,100 chars (−55%); small specimen ~−75%.
- ⏳ `memory_get` on `aaea192c-edce-4372-b011-5113a02dea16` returns inline
  instead of spilling to a file. **This is the check that matters** — it is the
  difference between the tool working and not working on large memories.

**P2** — all verified against a real Postgres.
- ✅ Unique `old_string` → applied; `version` incremented by exactly 1.
- ✅ Absent `old_string` → error; content byte-identical afterward.
- ✅ `old_string` occurring twice → error naming the count; content unchanged.
- ✅ Stale `version` → concurrent-edit error; content unchanged.
- ✅ Content exceeding 64,000 chars post-patch → rejected.
- ✅ Re-embedding — see the caveat below.

**A trap in the re-embedding check.** The original draft proposed "after a
patch, `memory_search` finds text introduced by that patch." *That test does not
work.* Search fuses three rankers via RRF, and because `content_tsv` is a
generated column the FTS ranker finds the literal inserted text **even if the
patch skipped re-embedding entirely** — it would pass on a broken
implementation. The shipped test asserts the **stored vector changed**, using a
deterministic per-text embedder stub. A separate test pins that `content_tsv`
updates itself, documenting why the naive check is misleading.

---

## 7. Test specimen

Memory `aaea192c-edce-4372-b011-5113a02dea16` (project
`cloud-hosting-platform/whp`, tags `roadmap` / `progress-tracker` / `planning`)
is a good real-world subject: ~13k chars, heading-structured, and its local
counterpart is
`/home/claude/.claude/projects/-workspace/memory/project_roadmap.md`.

**It is live team data.** Check its `updatedAt` and `version` before using it as
a fixture, and prefer a scratch memory for destructive tests.
