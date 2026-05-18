# -----------------------------------------------------------------------------
# Inputs. Required vars have no default; everything else has a sensible one.
#
# Secrets (database_url, *_secret) are marked sensitive so they don't surface
# in `terraform plan` / `apply` output. They still flow through state, so
# protect the state backend accordingly (see README "Security note").
# -----------------------------------------------------------------------------

# -------- Identity / wiring --------

variable "name_prefix" {
  description = "Prefix applied to every named resource (e.g. shared-memory-prod). Keep under 24 chars so generated names stay within AWS limits."
  type        = string
}

variable "vpc_id" {
  description = "ID of the VPC where the ALB, ECS tasks, EFS, and security groups are created."
  type        = string
}

variable "public_subnet_ids" {
  description = "Public subnets (at least 2 AZs) that host the ALB."
  type        = list(string)

  validation {
    condition     = length(var.public_subnet_ids) >= 2
    error_message = "Provide at least two public subnets for ALB HA."
  }
}

variable "private_subnet_ids" {
  description = "Private subnets (at least 2 AZs) where ECS tasks and EFS mount targets live."
  type        = list(string)

  validation {
    condition     = length(var.private_subnet_ids) >= 2
    error_message = "Provide at least two private subnets for task HA."
  }
}

# -------- TLS / DNS --------

variable "acm_certificate_arn" {
  description = "ACM certificate ARN attached to the ALB's HTTPS listener. Must be in the same region as the ALB."
  type        = string
}

variable "domain_name" {
  description = "Public hostname (e.g. memory.example.com). Used to build PUBLIC_URL/AUTH_URL passed to the app."
  type        = string
}

# -------- Container images --------

variable "app_image" {
  description = "Fully qualified image URI for the web app (e.g. 12345.dkr.ecr.us-east-1.amazonaws.com/shared-memory-web:v0.5.0). Same image is reused for the migrator."
  type        = string
}

variable "embedder_image" {
  description = "Fully qualified image URI for the embedder sidecar."
  type        = string
}

# -------- Database --------

variable "database_url" {
  description = "Postgres connection URL, e.g. postgres://user:pw@host:5432/db. Stored in Secrets Manager. Host must be reachable from the private subnets."
  type        = string
  sensitive   = true
}

# -------- OIDC --------

variable "oidc_issuer" {
  description = "OIDC issuer URL (matches `iss` claim). Both web and MCP clients must live at this issuer."
  type        = string
}

variable "oidc_client_id_web" {
  description = "Confidential client ID for the Web UI."
  type        = string
}

variable "oidc_client_secret_web" {
  description = "Confidential client secret for the Web UI. Stored in Secrets Manager."
  type        = string
  sensitive   = true
}

variable "oidc_client_id_mcp" {
  description = "Public (PKCE) client ID used by Claude Code against /api/mcp."
  type        = string
}

variable "oidc_audience" {
  description = "Expected `aud` claim on MCP access tokens. Typically 'shared-memory'."
  type        = string
}

# -------- App-level secrets --------

variable "nextauth_secret" {
  description = "Session cookie signing key for Auth.js. Generate with `openssl rand -base64 32`."
  type        = string
  sensitive   = true
}

variable "cli_token_secret" {
  description = "HMAC key used by /connect to mint long-lived CLI tokens."
  type        = string
  sensitive   = true
}

# -------- Embedder model knobs (rarely overridden) --------

variable "embedding_model" {
  description = "Xenova/transformers model identifier the embedder downloads on cold start."
  type        = string
  default     = "Xenova/bge-small-en-v1.5"
}

variable "embedding_dim" {
  description = "Output dimension of the chosen embedding model. Must match the pgvector column width."
  type        = number
  default     = 384
}

# -------- Fargate sizing --------

variable "app_cpu" {
  description = "Fargate CPU units for the app task. 512 = 0.5 vCPU, 1024 = 1 vCPU."
  type        = number
  default     = 512
}

variable "app_memory" {
  description = "Fargate memory (MiB) for the app task."
  type        = number
  default     = 1024
}

variable "app_desired_count" {
  description = "Number of app task replicas."
  type        = number
  default     = 1
}

variable "embedder_cpu" {
  description = "Fargate CPU units for the embedder. The model needs ~1 vCPU for tolerable latency."
  type        = number
  default     = 1024
}

variable "embedder_memory" {
  description = "Fargate memory (MiB) for the embedder. 2 GiB is comfortable for bge-small."
  type        = number
  default     = 2048
}

variable "embedder_desired_count" {
  description = "Number of embedder task replicas."
  type        = number
  default     = 1
}

variable "migrator_cpu" {
  description = "Fargate CPU units for the one-shot migrator task."
  type        = number
  default     = 512
}

variable "migrator_memory" {
  description = "Fargate memory (MiB) for the one-shot migrator task."
  type        = number
  default     = 1024
}

# -------- Observability / misc --------

variable "log_level" {
  description = "LOG_LEVEL env var passed to app and embedder."
  type        = string
  default     = "info"
}

variable "log_retention_days" {
  description = "CloudWatch retention applied to every log group the module creates."
  type        = number
  default     = 14
}

variable "enable_execute_command" {
  description = <<-EOT
    Enable AWS ECS Execute Command on the app + embedder services. When true,
    operators with the appropriate IAM permission can `aws ecs execute-command`
    into a running task — useful for debugging, dangerous as a standing
    posture (any principal with `ecs:ExecuteCommand` on these services gets a
    shell inside the container). Defaults `false`. Flip to `true` for an
    incident, then back to `false` and re-apply when done.

    When enabled, the module also attaches the SSM messages policy to both
    task roles so the feature actually works.
  EOT
  type        = bool
  default     = false
}

variable "tags" {
  description = "Tags merged onto every resource the module creates."
  type        = map(string)
  default     = {}
}
