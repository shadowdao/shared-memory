# -----------------------------------------------------------------------------
# Secrets Manager — one secret per value (not one big JSON blob). Task
# definitions pull these via the `secrets` block, which injects them as
# environment variables at task start. The raw values never appear in the
# task definition, only the secret ARNs.
#
# Each secret is paired with an aws_secretsmanager_secret_version so the
# initial value is populated on apply. Rotating later is the user's call:
# either re-run `terraform apply` with a new variable, or update the secret
# value out-of-band (AWS console / CLI) and the next task placement picks
# it up automatically.
# -----------------------------------------------------------------------------

# DATABASE_URL — full postgres://user:pw@host/db connection string.
resource "aws_secretsmanager_secret" "database_url" {
  name        = "${var.name_prefix}/DATABASE_URL"
  description = "Postgres connection URL for shared-memory app + migrator"
  tags        = local.tags
}

resource "aws_secretsmanager_secret_version" "database_url" {
  secret_id     = aws_secretsmanager_secret.database_url.id
  secret_string = var.database_url
}

# NEXTAUTH_SECRET — Auth.js cookie signing.
resource "aws_secretsmanager_secret" "nextauth_secret" {
  name        = "${var.name_prefix}/NEXTAUTH_SECRET"
  description = "Auth.js session cookie HMAC key"
  tags        = local.tags
}

resource "aws_secretsmanager_secret_version" "nextauth_secret" {
  secret_id     = aws_secretsmanager_secret.nextauth_secret.id
  secret_string = var.nextauth_secret
}

# CLI_TOKEN_SECRET — HMAC for /connect-minted bearer tokens.
resource "aws_secretsmanager_secret" "cli_token_secret" {
  name        = "${var.name_prefix}/CLI_TOKEN_SECRET"
  description = "HMAC key for shared-memory CLI bearer tokens"
  tags        = local.tags
}

resource "aws_secretsmanager_secret_version" "cli_token_secret" {
  secret_id     = aws_secretsmanager_secret.cli_token_secret.id
  secret_string = var.cli_token_secret
}

# OIDC_CLIENT_SECRET_WEB — confidential client secret for the Web UI.
resource "aws_secretsmanager_secret" "oidc_client_secret_web" {
  name        = "${var.name_prefix}/OIDC_CLIENT_SECRET_WEB"
  description = "OIDC confidential client secret for the Web UI"
  tags        = local.tags
}

resource "aws_secretsmanager_secret_version" "oidc_client_secret_web" {
  secret_id     = aws_secretsmanager_secret.oidc_client_secret_web.id
  secret_string = var.oidc_client_secret_web
}

# Convenience map — used in outputs and to feed the task execution role
# policy with the exact ARNs it needs to decrypt.
locals {
  secret_arns = {
    DATABASE_URL           = aws_secretsmanager_secret.database_url.arn
    NEXTAUTH_SECRET        = aws_secretsmanager_secret.nextauth_secret.arn
    CLI_TOKEN_SECRET       = aws_secretsmanager_secret.cli_token_secret.arn
    OIDC_CLIENT_SECRET_WEB = aws_secretsmanager_secret.oidc_client_secret_web.arn
  }
}
