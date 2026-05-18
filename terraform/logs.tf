# -----------------------------------------------------------------------------
# CloudWatch log groups — one per service. The ECS task definitions reference
# these via `awslogs-group`. Retention is configurable via var.log_retention_days.
# -----------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "app" {
  name              = "/ecs/${var.name_prefix}/app"
  retention_in_days = var.log_retention_days
  tags              = local.tags
}

resource "aws_cloudwatch_log_group" "embedder" {
  name              = "/ecs/${var.name_prefix}/embedder"
  retention_in_days = var.log_retention_days
  tags              = local.tags
}

resource "aws_cloudwatch_log_group" "migrator" {
  name              = "/ecs/${var.name_prefix}/migrator"
  retention_in_days = var.log_retention_days
  tags              = local.tags
}

# Service Connect proxy (Envoy) logs go here. ECS writes these automatically
# when the service has service_connect_configuration with log_configuration.
resource "aws_cloudwatch_log_group" "service_connect" {
  name              = "/ecs/${var.name_prefix}/service-connect"
  retention_in_days = var.log_retention_days
  tags              = local.tags
}
