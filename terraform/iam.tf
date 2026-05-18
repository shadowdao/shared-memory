# -----------------------------------------------------------------------------
# IAM. Two role kinds:
#
#   * Task execution role — used by the ECS agent itself to pull images,
#     fetch secrets, and write logs. Shared across all three task defs.
#   * Task role — assumed by the running container. We give every service
#     its own (even if empty today) so future per-service permissions (S3,
#     SES, etc.) can be granted without widening blast radius.
# -----------------------------------------------------------------------------

# ---- Task execution role ----

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${var.name_prefix}-ecs-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
  tags               = local.tags
}

# AWS-managed policy: pull from ECR, write to CloudWatch.
resource "aws_iam_role_policy_attachment" "execution_default" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Allow the execution role to decrypt the specific secrets this module owns.
# Scoped to the module's secret ARNs only — no wildcard against the account.
data "aws_iam_policy_document" "execution_secrets" {
  statement {
    sid       = "ReadModuleSecrets"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = values(local.secret_arns)
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  name   = "${var.name_prefix}-execution-secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution_secrets.json
}

# ---- Task roles (one per service; empty by default but ready to be widened) ----

resource "aws_iam_role" "app_task" {
  name               = "${var.name_prefix}-app-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
  tags               = local.tags
}

resource "aws_iam_role" "embedder_task" {
  name               = "${var.name_prefix}-embedder-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
  tags               = local.tags
}

resource "aws_iam_role" "migrator_task" {
  name               = "${var.name_prefix}-migrator-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
  tags               = local.tags
}
