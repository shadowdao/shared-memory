import { describe, expect, test } from "vitest";
import { applyPatch } from "@/lib/memory-patch";

describe("applyPatch", () => {
  test("replaces an old_string that occurs exactly once", () => {
    const result = applyPatch("alpha beta gamma", "beta", "BETA");

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.content).toBe("alpha BETA gamma");
  });

  test("refuses when old_string is absent, rather than silently doing nothing", () => {
    const result = applyPatch("alpha beta gamma", "delta", "DELTA");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not found/i);
  });

  test("refuses when old_string is ambiguous, and reports the match count", () => {
    const result = applyPatch("x marks the spot, x marks it twice", "x", "y");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/2/);
      expect(result.error).toMatch(/match/i);
    }
  });

  test("treats old_string literally, not as a regular expression", () => {
    // A naive RegExp implementation would match "axb" here.
    const result = applyPatch("axb and a.b", "a.b", "REPLACED");

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.content).toBe("axb and REPLACED");
  });

  test("replaces a multi-line old_string, preserving surrounding text", () => {
    const content = "## HEADING\n- one\n- two\n\n## OTHER\n";
    const result = applyPatch(content, "## HEADING\n- one", "## HEADING\n- zero\n- one");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content).toBe("## HEADING\n- zero\n- one\n- two\n\n## OTHER\n");
    }
  });

  test("rejects a patch whose result would exceed the 64,000-char content limit", () => {
    // The anchor must be unique, or the ambiguity check fires first and
    // this stops testing the length limit at all.
    const content = "A".repeat(63_950) + "ANCHOR";
    const result = applyPatch(content, "ANCHOR", "B".repeat(100));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/64,?000|limit/i);
  });

  test("rejects a no-op patch where new_string equals old_string", () => {
    const result = applyPatch("alpha beta", "beta", "beta");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/identical|no-op|unchanged/i);
  });

  test("allows a patch that deletes text by replacing with an empty string", () => {
    const result = applyPatch("keep this, drop this", ", drop this", "");

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.content).toBe("keep this");
  });

  test("rejects a patch that would empty the memory entirely", () => {
    const result = applyPatch("all of it", "all of it", "");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/empty/i);
  });
});
