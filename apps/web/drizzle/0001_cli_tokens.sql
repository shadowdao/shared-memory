-- cli_tokens: registry of HMAC-signed tokens minted at /connect.
--
-- Each row corresponds to one issued JWT. The token's `jti` claim is the
-- unique identifier — we store the full jti, not a hash, since the jti
-- itself isn't a secret (it's just a UUID; the signing material is
-- CLI_TOKEN_SECRET).
--
-- Soft-delete via revoked_at — never DROP rows; audit value lasts past
-- the JWT's natural expiration.

CREATE TABLE "cli_tokens" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"       uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "jti"           text NOT NULL UNIQUE,
  "name"          text NOT NULL,
  "created_at"    timestamptz NOT NULL DEFAULT now(),
  "last_used_at"  timestamptz,
  "expires_at"    timestamptz NOT NULL,
  "revoked_at"    timestamptz
);

CREATE INDEX "cli_tokens_user_idx"        ON "cli_tokens" ("user_id");
CREATE INDEX "cli_tokens_user_active_idx" ON "cli_tokens" ("user_id", "revoked_at")
  WHERE "revoked_at" IS NULL;
