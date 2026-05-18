# -----------------------------------------------------------------------------
# Security groups. One per logical tier; rules are kept tight on inbound and
# permissive on egress (Fargate needs to reach ECR, Secrets Manager, and
# CloudWatch — locking egress requires VPC endpoints, which the user owns).
#
# Note: the RDS security group is NOT created here. The user must add an
# inbound rule on their RDS SG allowing 5432 from the embedder/app task SGs
# (see outputs `app_security_group_id` / `embedder_security_group_id`).
# -----------------------------------------------------------------------------

# ALB — internet-facing, terminates TLS, accepts 80 (redirect) and 443.
resource "aws_security_group" "alb" {
  name        = "${var.name_prefix}-alb"
  description = "shared-memory ALB: HTTPS in from internet, app out"
  vpc_id      = var.vpc_id
  tags        = merge(local.tags, { Name = "${var.name_prefix}-alb" })
}

resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTP (redirected to HTTPS)"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTPS from the internet"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "alb_all" {
  security_group_id = aws_security_group.alb.id
  description       = "ALB to app tasks (and anywhere — narrowed by destination SG)"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

# App tasks — accept 3000 only from the ALB SG.
resource "aws_security_group" "app" {
  name        = "${var.name_prefix}-app"
  description = "shared-memory app tasks: 3000 in from ALB only"
  vpc_id      = var.vpc_id
  tags        = merge(local.tags, { Name = "${var.name_prefix}-app" })
}

resource "aws_vpc_security_group_ingress_rule" "app_from_alb" {
  security_group_id            = aws_security_group.app.id
  description                  = "App port from ALB"
  ip_protocol                  = "tcp"
  from_port                    = local.app_port
  to_port                      = local.app_port
  referenced_security_group_id = aws_security_group.alb.id
}

resource "aws_vpc_security_group_egress_rule" "app_all" {
  security_group_id = aws_security_group.app.id
  description       = "Egress to embedder, RDS, ECR, Secrets Manager, CloudWatch, OIDC IdP"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

# Embedder tasks — accept 8080 only from app SG.
resource "aws_security_group" "embedder" {
  name        = "${var.name_prefix}-embedder"
  description = "shared-memory embedder tasks: 8080 in from app only"
  vpc_id      = var.vpc_id
  tags        = merge(local.tags, { Name = "${var.name_prefix}-embedder" })
}

resource "aws_vpc_security_group_ingress_rule" "embedder_from_app" {
  security_group_id            = aws_security_group.embedder.id
  description                  = "Embedder port from app tasks"
  ip_protocol                  = "tcp"
  from_port                    = local.embedder_port
  to_port                      = local.embedder_port
  referenced_security_group_id = aws_security_group.app.id
}

# The migrator runs the embedding backfill against the embedder, so it
# needs the same path as the app does.
resource "aws_vpc_security_group_ingress_rule" "embedder_from_migrator" {
  security_group_id            = aws_security_group.embedder.id
  description                  = "Embedder port from migrator one-shot task"
  ip_protocol                  = "tcp"
  from_port                    = local.embedder_port
  to_port                      = local.embedder_port
  referenced_security_group_id = aws_security_group.migrator.id
}

resource "aws_vpc_security_group_egress_rule" "embedder_all" {
  security_group_id = aws_security_group.embedder.id
  description       = "Egress to Hugging Face (model download), ECR, Secrets Manager, CloudWatch"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

# Migrator one-shot task — gets its own SG so RDS allow-lists are clearer.
resource "aws_security_group" "migrator" {
  name        = "${var.name_prefix}-migrator"
  description = "shared-memory migrator one-shot task (no inbound)"
  vpc_id      = var.vpc_id
  tags        = merge(local.tags, { Name = "${var.name_prefix}-migrator" })
}

resource "aws_vpc_security_group_egress_rule" "migrator_all" {
  security_group_id = aws_security_group.migrator.id
  description       = "Egress to RDS, embedder, ECR, Secrets Manager, CloudWatch"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

# EFS mount targets — accept NFS only from embedder SG (the only mounter).
resource "aws_security_group" "efs" {
  name        = "${var.name_prefix}-efs"
  description = "shared-memory EFS: 2049/tcp in from embedder tasks"
  vpc_id      = var.vpc_id
  tags        = merge(local.tags, { Name = "${var.name_prefix}-efs" })
}

resource "aws_vpc_security_group_ingress_rule" "efs_from_embedder" {
  security_group_id            = aws_security_group.efs.id
  description                  = "NFS from embedder tasks"
  ip_protocol                  = "tcp"
  from_port                    = 2049
  to_port                      = 2049
  referenced_security_group_id = aws_security_group.embedder.id
}
