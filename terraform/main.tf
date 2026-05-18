# -----------------------------------------------------------------------------
# shared-memory — AWS Fargate deployment module
#
# Deploys the three runtime components (app, embedder, migrator) as ECS
# tasks behind an internet-facing ALB. The user is responsible for the VPC,
# RDS Postgres, ACM cert, ECR images, and OIDC clients (see README).
#
# Region is inherited from the configured AWS provider — do not hardcode.
# -----------------------------------------------------------------------------

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

locals {
  # Merged tag set applied to every resource in the module. Callers can pin
  # cost-allocation tags / environment markers via var.tags.
  tags = merge(
    {
      "managed-by" = "terraform"
      "module"     = "shared-memory"
    },
    var.tags,
  )

  # Public URL is the canonical external origin — feeds PUBLIC_URL, AUTH_URL,
  # and OIDC redirect URIs alike.
  public_url = "https://${var.domain_name}"

  # Service Connect namespace name. One per module instance so multiple
  # deployments (e.g. staging + prod in one cluster) don't collide.
  service_connect_namespace = "${var.name_prefix}.internal"

  # Port constants — keep these aligned with the Dockerfiles.
  app_port      = 3000
  embedder_port = 8080
}
