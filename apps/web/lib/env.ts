import { z } from "zod";

const Bool = z
  .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
  .transform((v) => v === true || v === "true" || v === "1");

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  // Public URL the app is reached at (used for OIDC redirects + MCP metadata)
  PUBLIC_URL: z.string().url(),

  // Authentik OIDC
  OIDC_ISSUER: z.string().url(),
  OIDC_CLIENT_ID_WEB: z.string().min(1),
  OIDC_CLIENT_SECRET_WEB: z.string().min(1),
  OIDC_CLIENT_ID_MCP: z.string().min(1),
  OIDC_AUDIENCE: z.string().min(1),

  // Database
  DATABASE_URL: z.string().url(),

  // Embedder (used in Phase 2; present-but-empty allowed in Phase 1)
  EMBEDDER_URL: z.string().url().optional(),
  EMBEDDING_MODEL: z.string().default("Xenova/bge-small-en-v1.5"),
  EMBEDDING_DIM: z.coerce.number().int().positive().default(384),

  // NextAuth
  NEXTAUTH_SECRET: z.string().min(32, "NEXTAUTH_SECRET must be at least 32 chars"),

  // Behavior flags
  ALLOW_INSECURE_HTTP: Bool.optional().default(false),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

// During `next build`, Next.js evaluates server modules to collect static
// page data — env vars aren't expected to be present then. Honor a build-only
// bypass so the image can be assembled without baking secrets in.
function isBuildPhase(): boolean {
  return (
    process.env.SKIP_ENV_VALIDATION === "true" ||
    process.env.NEXT_PHASE === "phase-production-build"
  );
}

function buildPhaseStub(): Env {
  return {
    NODE_ENV: "production",
    LOG_LEVEL: "info",
    PUBLIC_URL: "https://build-phase.invalid",
    OIDC_ISSUER: "https://build-phase.invalid",
    OIDC_CLIENT_ID_WEB: "build",
    OIDC_CLIENT_SECRET_WEB: "build",
    OIDC_CLIENT_ID_MCP: "build",
    OIDC_AUDIENCE: "build",
    DATABASE_URL: "postgres://build:build@build-phase.invalid:5432/build",
    EMBEDDER_URL: undefined,
    EMBEDDING_MODEL: "Xenova/bge-small-en-v1.5",
    EMBEDDING_DIM: 384,
    NEXTAUTH_SECRET: "build-phase-secret-not-used-at-runtime-xxxxxxxx",
    ALLOW_INSECURE_HTTP: false,
  };
}

// Lazy singleton so importing this module at build time doesn't crash when
// env vars are absent (e.g. during `next build` without runtime values).
let cached: Env | null = null;

export function env(): Env {
  if (cached) return cached;
  cached = isBuildPhase() ? buildPhaseStub() : loadEnv();
  return cached;
}

// Convenience getter for code paths that only need a single var without
// triggering full validation (rare; prefer `env()`).
export function rawEnv(key: keyof Env): string | undefined {
  return process.env[key];
}
