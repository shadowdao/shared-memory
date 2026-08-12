-- EntraID identity: key users on `oid` when the IdP emits it.
--
-- EntraID's `sub` is a PAIRWISE identifier — derived from the token recipient,
-- so the Web UI app registration and the MCP app registration hand out
-- different `sub` values for the same person. Both `auth.ts` and
-- `lib/mcp/context.ts` upsert on (oidc_iss, oidc_sub), so on EntraID one human
-- resolves to two rows: they sign into the Web UI, connect an MCP client, and
-- land in an empty account with their memories nowhere to be seen. Nothing
-- errors, which is what makes it dangerous.
--
-- `oid` is the user's directory object id, which Microsoft documents as
-- constant for a user across every application in a tenant. Recording it gives
-- us a key that holds across both surfaces.
--
-- Nullable on purpose: Authentik, Keycloak and Okta emit no `oid`, and there
-- `sub` is already application-independent. Those deployments keep using
-- (oidc_iss, oidc_sub) and are untouched by this migration.

ALTER TABLE "users" ADD COLUMN "oidc_oid" text;

-- Partial index. Every non-EntraID row holds NULL here; a plain unique index
-- would treat those as colliding and permit exactly one such user.
CREATE UNIQUE INDEX "users_iss_oid_uq"
  ON "users" ("oidc_iss", "oidc_oid")
  WHERE "oidc_oid" IS NOT NULL;

-- No backfill. `oid` is only knowable from a token, so existing rows adopt
-- theirs on the owner's next sign-in (see `adoptLegacyRow` in
-- lib/auth/identity.ts). Backfilling would mean guessing.
