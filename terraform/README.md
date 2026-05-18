# shared-memory — Terraform module (AWS Fargate)

Deploys [shared-memory](../README.md) to AWS Fargate ECS behind an ALB.
Brings up the `app` (Next.js web + MCP endpoint), the `embedder` sidecar
(Xenova bge-small on CPU, EFS-backed model cache), and a one-shot
`migrator` task definition. Targets an externally-managed RDS Postgres
instance and an existing OIDC identity provider — neither is the module's
job.

---

## What you provide before running

The module deliberately stops short of creating shared infrastructure
that's usually account-wide and not specific to this app. You bring:

### 1. A VPC with public + private subnets

At least two of each across two AZs. Public subnets host the internet-facing
ALB; private subnets host the Fargate tasks and EFS mount targets. The
private subnets need outbound internet access (NAT gateway or VPC endpoints
for ECR / Secrets Manager / CloudWatch / Hugging Face) so tasks can pull
images, decrypt secrets, and on first cold start download the embedding
model.

### 2. An RDS Postgres instance

Postgres **≥ 15.5** with `pgvector`, `pg_trgm`, and `pgcrypto`. RDS makes
all three available on modern versions; you may need to add them to
`rds.allowed_extensions` in the parameter group, but the migrator runs
`CREATE EXTENSION IF NOT EXISTS …` itself.

Connectivity gotcha: the RDS security group is owned by you. After
`terraform apply` you must add an inbound rule on it allowing 5432 from
the module's task security groups. Use the outputs:

```
app_security_group_id        # app needs RDS for runtime queries
migrator_security_group_id   # migrator needs RDS for DDL on apply
```

The embedder does **not** talk to Postgres.

### 3. An ACM certificate

In the **same region** as the ALB (ACM certs are regional). Cover the
public hostname you'll use for `domain_name`. DNS validation is the
easiest route; AWS docs walk through it.

### 4. ECR repositories with pushed images

The module references `var.app_image` and `var.embedder_image` by URI —
it doesn't build, doesn't push, doesn't create the repos. Two repos
typically:

```
shared-memory-web        # built from apps/web/Dockerfile
shared-memory-embedder   # built from apps/embedder/Dockerfile
```

Build from the repo root and tag with whatever version scheme you prefer
(git SHA, semver, etc.). The app and embedder images use unrelated runtime
stacks (Node alpine vs Node slim) — keep them as separate repos.

### 5. OIDC clients

Two clients in your IdP (Authentik, EntraID, Keycloak, …) — one
confidential for the Web UI, one public/PKCE for the MCP endpoint. See the
[main README](../README.md#oidc-provider-setup) for the Authentik walkthrough.

The redirect URI you register on the Web UI client is
`https://${domain_name}/api/auth/callback/oidc`, so plan the domain name
*before* configuring the IdP.

---

## Quick start

```bash
cd terraform/examples/basic

# 1. Edit main.tf — replace vpc-…, subnet-…, ARN placeholders, image URIs.
$EDITOR main.tf

# 2. Create terraform.tfvars with the sensitive values (0600 perms!).
umask 077
cat > terraform.tfvars <<EOF
database_url            = "postgres://memory:CHANGEME@my-rds-host.us-east-1.rds.amazonaws.com:5432/memory"
oidc_client_id_web      = "abc123…"
oidc_client_secret_web  = "secretvalue"
oidc_client_id_mcp      = "def456…"
nextauth_secret         = "$(openssl rand -base64 32)"
cli_token_secret        = "$(openssl rand -base64 32)"
EOF
chmod 600 terraform.tfvars

# 3. Apply.
terraform init
terraform plan -out plan.out
terraform apply plan.out
```

`terraform apply` creates the ECS cluster, both services, the ALB, EFS,
Secrets Manager entries, log groups, security groups, and the migrator
task definition. It does **not** run migrations — the migrator is a
one-shot task you trigger separately. See the next section.

After apply, expect the **embedder** to take 60–180 seconds on first
boot to download the bge-small model to EFS. Subsequent restarts are
warm because EFS keeps the cache.

---

## Post-apply: run the migrator and verify

The migrator creates schema, applies SQL migrations from
`apps/web/drizzle/`, and (if any rows already exist) backfills embeddings.
It must run **before** the app is useful, but the module ships it as a
task definition with no service so you can run it explicitly.

### Run it

```bash
CLUSTER=$(terraform output -raw ecs_cluster_name)
FAMILY=$(terraform output -raw migrator_task_definition_family)
SG=$(terraform output -raw migrator_security_group_id)
SUBNETS=$(terraform output -json private_subnet_ids | jq -r 'join(",")')

aws ecs run-task \
  --cluster "$CLUSTER" \
  --task-definition "$FAMILY" \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$SG],assignPublicIp=DISABLED}"
```

The task exits 0 on success and a non-zero exit on failure. Watch it:

```bash
aws ecs list-tasks --cluster "$CLUSTER" --family "$FAMILY"
aws ecs describe-tasks --cluster "$CLUSTER" --tasks <task-id>
```

### Read its logs

```bash
LOG_GROUP=$(terraform output -raw migrator_log_group_name)

aws logs tail "$LOG_GROUP" --follow
```

A healthy run prints `Migrations complete.` and (if you have prior data)
`Embedding backfill complete: N memories embedded.`.

You should re-run the migrator after **every** deploy that ships a new
SQL migration file. It's idempotent — already-applied migrations are
skipped via the `_migrations` ledger table.

### Verify the app is up

```bash
ALB=$(terraform output -raw alb_dns_name)
curl -fsS "https://$ALB/api/health"   # — once DNS / cert is wired up
```

(If DNS isn't wired yet, you can `curl --resolve memory.example.com:443:<ALB-IP>`
to test against the cert without touching DNS.)

---

## Updating images

Push a new tag to ECR, then re-apply with the new tag:

```bash
terraform apply -var 'app_image=…/shared-memory-web:v0.5.1'
```

ECS performs a rolling deploy: `deployment_minimum_healthy_percent = 50`
and `deployment_maximum_percent = 200` mean it stands up new tasks before
draining old ones. If the new tasks fail their ALB health check the old
ones stay.

If the new image ships a SQL migration, **run the migrator again first**
(or right after; the SQL is backwards-compatible in this codebase), then
roll the app.

The embedder side is rarer to update — the image hardly changes. When it
does, EFS keeps the existing model cache so the new revision is warm
immediately.

---

## DNS setup

The ALB has a generated DNS name (`…elb.amazonaws.com`); you point your
real hostname at it with an A-alias record.

If your DNS lives in Route53:

```hcl
resource "aws_route53_record" "app" {
  zone_id = "Z0123456789ABCDEFG"   # your hosted zone
  name    = "memory.example.com"
  type    = "A"

  alias {
    name                   = module.shared_memory.alb_dns_name
    zone_id                = module.shared_memory.alb_zone_id
    evaluate_target_health = true
  }
}
```

If your DNS is elsewhere (Cloudflare, NS1, …), a CNAME from
`memory.example.com` → `<alb_dns_name>` works equivalently, modulo apex
limitations.

Once DNS propagates, the OIDC callback URL you registered earlier
(`https://memory.example.com/api/auth/callback/oidc`) will start working
and you can sign in.

---

## Security note

Several inputs (`database_url`, `nextauth_secret`, `cli_token_secret`,
`oidc_client_secret_web`) are sensitive. The module marks them as such so
they're scrubbed from CLI output, but they still:

- Pass through `terraform plan` and `terraform apply`
- Land in `terraform.tfstate`
- Round-trip through Secrets Manager versions

Hardening checklist:

- Put values in `terraform.tfvars` (not committed) with `chmod 600`.
- Use a remote state backend with encryption (S3 + KMS) and tight IAM
  on the bucket. Local state in a shared repo is the failure mode.
- Consider an external secret manager (1Password, Doppler, Vault) and
  feeding values via `-var-file` from a `terraform-data` shim. The
  module accepts plain strings — keep the indirection outside.
- Rotate `nextauth_secret` and `cli_token_secret` periodically. Both can
  change with no DB migration; in-flight sessions and unexpired CLI
  tokens will be invalidated.

The module's Secrets Manager entries are scoped under
`${name_prefix}/<ENV_VAR_NAME>` and the task execution role has
`secretsmanager:GetSecretValue` on those ARNs only — no wildcard.

---

## What the module creates

| Resource | Purpose |
|---|---|
| `aws_ecs_cluster` | Fargate cluster, Service Connect default namespace |
| `aws_ecs_service.app` | Web/MCP service behind ALB |
| `aws_ecs_service.embedder` | Internal sidecar service |
| `aws_ecs_task_definition.{app,embedder,migrator}` | Task defs |
| `aws_lb` + listener + target group | Public ALB, HTTPS + redirect |
| `aws_efs_file_system` + access point + mount targets | Embedder model cache |
| `aws_secretsmanager_secret.*` (4) | DATABASE_URL, NEXTAUTH_SECRET, CLI_TOKEN_SECRET, OIDC_CLIENT_SECRET_WEB |
| `aws_cloudwatch_log_group.*` (4) | app, embedder, migrator, service-connect |
| `aws_security_group.{alb,app,embedder,migrator,efs}` | Tier security groups |
| `aws_iam_role.{execution,app_task,embedder_task,migrator_task}` | Execution + per-service task roles |
| `aws_service_discovery_http_namespace` | Service Connect namespace `${name_prefix}.internal` |

## What the module does NOT create

- VPC, subnets, NAT, route tables — you own these
- RDS instance, parameter group, subnet group — you own
- ACM certificate or its DNS validation records — you own
- ECR repositories or the image build pipeline — you own
- OIDC clients — you own
- Route53 records — you own (see [DNS setup](#dns-setup))
- WAF, Shield, CloudFront — out of scope

## Module inputs

See [`variables.tf`](variables.tf) for the full list with descriptions
and defaults.

## Module outputs

See [`outputs.tf`](outputs.tf). The ones you'll use:

- `alb_dns_name`, `alb_zone_id` — for the Route53 alias
- `ecs_cluster_name`, `migrator_task_definition_family`,
  `private_subnet_ids_for_run_task`, `migrator_security_group_id` —
  to assemble the `aws ecs run-task` call
- `app_security_group_id` / `migrator_security_group_id` — to whitelist
  on your RDS SG
- `app_log_group_name`, `embedder_log_group_name`, `migrator_log_group_name` —
  for `aws logs tail`

## Worked example

See [`examples/basic/`](examples/basic/).
