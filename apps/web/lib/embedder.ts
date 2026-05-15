import { env } from "@/lib/env";

/**
 * Thin HTTP client for the embedder sidecar. Used by memory.write /
 * memory.update / memory.search and by the migrator's backfill step.
 *
 * Calls are blocking on purpose — write-path latency is a worthwhile
 * trade for "the memory I just wrote is searchable now."
 */

export class EmbedderError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "EmbedderError";
  }
}

function url(): string {
  const u = env().EMBEDDER_URL;
  if (!u) throw new EmbedderError("EMBEDDER_URL is not configured");
  return u.replace(/\/$/, "");
}

/** Embed a batch of texts. Returns one vector per input. */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const res = await fetch(`${url()}/embed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ texts }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new EmbedderError(
      `embedder returned ${res.status}: ${detail.slice(0, 200)}`,
      res.status,
    );
  }
  const body = (await res.json()) as { vectors: number[][] };
  if (!Array.isArray(body.vectors) || body.vectors.length !== texts.length) {
    throw new EmbedderError("embedder response shape mismatch");
  }
  return body.vectors;
}

/** Embed a single text — convenience for one-off calls. */
export async function embedText(text: string): Promise<number[]> {
  const [vec] = await embedTexts([text]);
  if (!vec) throw new EmbedderError("embedder returned no vector");
  return vec;
}

/** Quick check used by the migrator before backfilling. */
export async function embedderReady(): Promise<boolean> {
  try {
    const res = await fetch(`${url()}/health`);
    if (!res.ok) return false;
    const body = (await res.json()) as { ready?: boolean };
    return body.ready === true;
  } catch {
    return false;
  }
}
