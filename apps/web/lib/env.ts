import { z } from "zod";

const Bool = z
  .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
  .transform((v) => v === true || v === "true" || v === "1");

/**
 * Treat an empty string as "not set".
 *
 * docker-compose renders `${VAR:-}` as an empty string rather than omitting
 * the key, so an unset optional var arrives as "" and would otherwise fail
 * `.url()` / `.min(1)` validation and take the whole app down at boot.
 */
const optional = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (v === "" ? undefined : v), schema.optional());

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  // Public URL the app is reached at (used for OIDC redirects + MCP metadata)
  PUBLIC_URL: z.string().url(),

  // Authentik OIDC
  OIDC_ISSUER: z.string().url(),

  // Issuer of MCP *access tokens*, when it differs from OIDC_ISSUER.
  //
  // The Web UI and the MCP endpoint are two separate applications in the IdP,
  // and Authentik's default `per_provider` issuer mode stamps each token with
  // its own application slug. So the web app issues
  // `.../application/o/<slug>/` while the MCP provider issues
  // `.../application/o/<slug>-mcp/`, and verifying MCP tokens against
  // OIDC_ISSUER fails with "claim invalid: iss".
  //
  // Set this to the MCP application's issuer. Defaults to OIDC_ISSUER for
  // single-application setups.
  OIDC_ISSUER_MCP: optional(z.string().url()),
  OIDC_CLIENT_ID_WEB: z.string().min(1),
  OIDC_CLIENT_SECRET_WEB: z.string().min(1),
  OIDC_CLIENT_ID_MCP: z.string().min(1),
  OIDC_AUDIENCE: z.string().min(1),

  // Name of the IdP scope whose mapping emits `aud: <OIDC_AUDIENCE>`.
  //
  // Most IdPs (Authentik included) only evaluate a scope mapping when the
  // client actually requests that scope. The MCP client learns which scopes
  // to request from `scopes_supported` in our protected-resource metadata,
  // so this name has to be advertised there or the mapping never runs and
  // every token arrives without an `aud` claim (-> 401 "claim invalid: aud").
  //
  // Defaults to the `aud-<audience>` convention used in the README setup.
  OIDC_AUDIENCE_SCOPE: optional(z.string().min(1)),

  // Database
  DATABASE_URL: z.string().url(),

  // Embedder sidecar — required in Phase 2 since memory.write embeds inline.
  EMBEDDER_URL: z.string().url(),
  EMBEDDING_MODEL: z.string().default("Xenova/bge-small-en-v1.5"),
  EMBEDDING_DIM: z.coerce.number().int().positive().default(384),

  // NextAuth
  NEXTAUTH_SECRET: z.string().min(32, "NEXTAUTH_SECRET must be at least 32 chars"),

  // Signing key for CLI tokens minted at /connect. Rotate this to invalidate
  // every issued CLI token at once.
  CLI_TOKEN_SECRET: z.string().min(32, "CLI_TOKEN_SECRET must be at least 32 chars"),

  // Plugin marketplace this instance is published from. When set, the CLI
  // tokens page shows the one-command plugin install, so people only mint a
  // bearer token when their machine genuinely can't complete a browser
  // sign-in. Left unset, that hint is hidden rather than shown wrong.
  PLUGIN_MARKETPLACE_URL: optional(z.string().url()),
  PLUGIN_MARKETPLACE_NAME: z.string().min(1).default("shared-memory"),

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
    EMBEDDER_URL: "http://embedder.invalid:8080",
    EMBEDDING_MODEL: "Xenova/bge-small-en-v1.5",
    EMBEDDING_DIM: 384,
    NEXTAUTH_SECRET: "build-phase-secret-not-used-at-runtime-xxxxxxxx",
    CLI_TOKEN_SECRET: "build-phase-secret-not-used-at-runtime-xxxxxxxx",
    PLUGIN_MARKETPLACE_NAME: "shared-memory",
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
