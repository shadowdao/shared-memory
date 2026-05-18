# Basic example — shared-memory on AWS Fargate

Minimal invocation of `../../`. Fill in your real IDs and run.

## Prereqs

Before you `terraform apply`, you need (see the [module README](../../README.md)
for the long version):

- A VPC with two public + two private subnets
- An RDS Postgres ≥ 15.5 instance with `pgvector`, `pg_trgm`, `pgcrypto`
  available (or creatable by the migrator on first run)
- An ACM certificate in the same region as the ALB, covering `domain_name`
- ECR repos populated with images for `apps/web` and `apps/embedder`
- OIDC clients registered (web confidential + MCP public/PKCE)

## Configure

1. Open `main.tf` and replace the placeholder `vpc-…` / `subnet-…` /
   `arn:aws:acm:…` / image URIs with your real values.

2. Create `terraform.tfvars` with the sensitive inputs and chmod it:

   ```bash
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
   ```

## Apply

```bash
terraform init
terraform plan -out plan.out
terraform apply plan.out
```

## Post-apply

Open the [module README](../../README.md#post-apply) for the migrator
`aws ecs run-task` invocation and the DNS setup.

The shortcut, using outputs from this directory:

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
