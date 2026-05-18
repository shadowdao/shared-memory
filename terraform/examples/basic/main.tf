# -----------------------------------------------------------------------------
# Worked example for the shared-memory Terraform module.
#
# This config does NOT create the VPC, RDS, ACM cert, ECR repos, or OIDC
# clients — see ../../README.md for the prerequisite checklist. Replace the
# placeholders below with the actual IDs from your environment.
# -----------------------------------------------------------------------------

terraform {
  required_version = "~> 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  # Region inherits from AWS_REGION / AWS_PROFILE / shared-config. Set it
  # here only if you want to pin it explicitly.
  # region = "us-east-1"
}

module "shared_memory" {
  source = "../../"

  # ---- Identity / wiring ----
  name_prefix        = "shared-memory-prod"
  vpc_id             = "vpc-0123456789abcdef0"
  public_subnet_ids  = ["subnet-aaa", "subnet-bbb"]
  private_subnet_ids = ["subnet-ccc", "subnet-ddd"]

  # ---- TLS / DNS ----
  acm_certificate_arn = "arn:aws:acm:us-east-1:123456789012:certificate/<uuid>"
  domain_name         = "memory.example.com"

  # ---- Images (push your own, then reference here) ----
  app_image      = "123456789012.dkr.ecr.us-east-1.amazonaws.com/shared-memory-web:v0.5.0"
  embedder_image = "123456789012.dkr.ecr.us-east-1.amazonaws.com/shared-memory-embedder:v0.5.0"

  # ---- Database (external RDS) ----
  # Format: postgres://USER:PASSWORD@HOST:5432/DBNAME
  # Real-world: pull from `aws_secretsmanager_secret_version` or `random_password`,
  # don't hardcode.
  database_url = var.database_url

  # ---- OIDC ----
  oidc_issuer            = "https://auth.example.com/application/o/shared-memory/"
  oidc_client_id_web     = var.oidc_client_id_web
  oidc_client_secret_web = var.oidc_client_secret_web
  oidc_client_id_mcp     = var.oidc_client_id_mcp
  oidc_audience          = "shared-memory"

  # ---- App-level secrets ----
  # Generate with: openssl rand -base64 32
  nextauth_secret  = var.nextauth_secret
  cli_token_secret = var.cli_token_secret

  # ---- Sizing (defaults are fine for small deployments) ----
  app_desired_count      = 1
  embedder_desired_count = 1

  tags = {
    environment = "prod"
    project     = "shared-memory"
  }
}

# ---- Sensitive inputs surfaced as vars so they live in terraform.tfvars
#      with 0600 perms (not in this file). See ../../README.md "Security note".

variable "database_url" {
  type      = string
  sensitive = true
}

variable "oidc_client_id_web" {
  type = string
}

variable "oidc_client_secret_web" {
  type      = string
  sensitive = true
}

variable "oidc_client_id_mcp" {
  type = string
}

variable "nextauth_secret" {
  type      = string
  sensitive = true
}

variable "cli_token_secret" {
  type      = string
  sensitive = true
}
