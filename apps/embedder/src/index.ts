/**
 * Embedder sidecar — loads a small ONNX model once at boot and serves
 * mean-pooled, L2-normalized sentence embeddings over HTTP.
 *
 * Endpoints:
 *   GET  /health  → { status, ready, model, dim }
 *   POST /embed   → { vectors: number[][] }   given { texts: string[] }
 *
 * Used by the web app's memory.write / memory.update / memory.search and
 * by the migrator's one-shot backfill step.
 */
import Fastify from "fastify";
import { pipeline, env as txEnv } from "@xenova/transformers";

// Persist the downloaded model on a named docker volume so subsequent
// boots don't re-fetch ~30 MB.
txEnv.cacheDir = process.env.MODEL_CACHE_DIR ?? "/data/models";
txEnv.allowLocalModels = true;
txEnv.allowRemoteModels = true;

const MODEL_NAME = process.env.EMBEDDING_MODEL ?? "Xenova/bge-small-en-v1.5";
const EXPECTED_DIM = Number.parseInt(process.env.EMBEDDING_DIM ?? "384", 10);
const PORT = Number.parseInt(process.env.PORT ?? "8080", 10);
const HOST = process.env.HOST ?? "0.0.0.0";

// The pipeline()'s return type is a giant union covering every task; we
// only use feature-extraction, so a narrower call signature is much easier
// to work with than the upstream typing.
interface FeatureExtractor {
  (
    texts: string[],
    options: { pooling: "mean" | "cls"; normalize: boolean },
  ): Promise<{ tolist: () => number[] | number[][] }>;
}
let extractor: FeatureExtractor | null = null;

async function loadModel() {
  const start = Date.now();
  console.log(`[embedder] loading ${MODEL_NAME}…`);
  // Quantized=true is the @xenova default and is fast enough; flip via env if
  // we ever need the full-precision model.
  extractor = (await pipeline("feature-extraction", MODEL_NAME, {
    quantized: process.env.EMBEDDER_QUANTIZED !== "false",
  })) as unknown as FeatureExtractor;
  console.log(`[embedder] model ready in ${Date.now() - start}ms`);
}

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? "info" },
  bodyLimit: 5 * 1024 * 1024, // 5 MB — generous for batched embeds
});

app.get("/health", async () => ({
  status: "ok",
  ready: extractor !== null,
  model: MODEL_NAME,
  dim: EXPECTED_DIM,
}));

interface EmbedRequest {
  texts: string[];
}

app.post("/embed", async (req, reply) => {
  if (!extractor) {
    return reply.code(503).send({ error: "model not loaded yet" });
  }

  const body = req.body as EmbedRequest | null;
  if (!body || !Array.isArray(body.texts)) {
    return reply.code(400).send({ error: "body must be { texts: string[] }" });
  }
  if (body.texts.length === 0) {
    return { vectors: [] };
  }
  if (body.texts.length > 256) {
    return reply.code(400).send({ error: "max 256 texts per request" });
  }
  if (body.texts.some((t) => typeof t !== "string")) {
    return reply.code(400).send({ error: "every entry in texts must be a string" });
  }

  // Mean-pool the per-token hidden states and L2-normalize so cosine sim
  // matches the inner-product distance we'll feed into pgvector.
  const output = await extractor(body.texts, {
    pooling: "mean",
    normalize: true,
  });

  // Transformers.js returns a Tensor; .tolist() gives nested JS arrays.
  // For batches the shape is [batch, dim]; for a single input the wrapper
  // may collapse to [dim] — defensively re-wrap.
  const raw = output.tolist();
  const vectors: number[][] = Array.isArray(raw[0])
    ? (raw as number[][])
    : [raw as number[]];

  // Sanity-check the dimension once at runtime — catches a model swap that
  // wasn't accompanied by an EMBEDDING_DIM bump.
  if (vectors[0] && vectors[0].length !== EXPECTED_DIM) {
    return reply.code(500).send({
      error: `model produced dim=${vectors[0].length}, expected ${EXPECTED_DIM}`,
    });
  }

  return { vectors };
});

async function start() {
  await loadModel();
  await app.listen({ host: HOST, port: PORT });
  console.log(`[embedder] listening on http://${HOST}:${PORT}`);
}

start().catch((err) => {
  console.error("[embedder] startup failed:", err);
  process.exit(1);
});
