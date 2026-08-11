import { MEMORY_CONTENT_MAX } from "@shared-memory/schemas";

/**
 * Pure string-level semantics for `memory.patch`.
 *
 * Kept free of any DB or auth dependency so both the MCP tool handler and
 * the Web UI can share it, and so the refuse-rather-than-clobber rules
 * below are directly testable.
 *
 * The contract mirrors the file-editing primitive coding agents already
 * use: an `old_string` that is absent or ambiguous is an ERROR, never a
 * silent no-op and never an arbitrary pick. That refusal is the property
 * that makes the operation safe to hand to an agent editing a shared
 * document it cannot afford to corrupt.
 */
export type PatchOutcome =
  | { ok: true; content: string }
  | { ok: false; error: string };

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    // Advance past this match so overlapping matches aren't double-counted.
    from = at + needle.length;
  }
}

export function applyPatch(
  content: string,
  oldString: string,
  newString: string,
): PatchOutcome {
  if (oldString === newString) {
    return {
      ok: false,
      error: "old_string and new_string are identical; the patch would change nothing",
    };
  }

  const first = content.indexOf(oldString);
  if (first === -1) {
    return {
      ok: false,
      error:
        "old_string not found in the memory content; nothing was changed. Fetch the memory with memory.get and copy the exact text you mean to replace.",
    };
  }

  // Only pay for a full count once we know there's more than one match.
  if (content.indexOf(oldString, first + oldString.length) !== -1) {
    const count = countOccurrences(content, oldString);
    return {
      ok: false,
      error: `old_string matches ${count} times; it must match exactly once. Nothing was changed — include more surrounding context to identify the one you mean.`,
    };
  }

  const patched =
    content.slice(0, first) + newString + content.slice(first + oldString.length);

  if (patched.length === 0) {
    return { ok: false, error: "the patch would leave the memory empty" };
  }
  if (patched.length > MEMORY_CONTENT_MAX) {
    return {
      ok: false,
      error: `the patched content would be ${patched.length.toLocaleString("en-US")} characters, over the ${MEMORY_CONTENT_MAX.toLocaleString("en-US")}-character limit`,
    };
  }

  return { ok: true, content: patched };
}
