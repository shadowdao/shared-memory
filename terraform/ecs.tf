# -----------------------------------------------------------------------------
# ECS cluster + services + task definitions.
#
# Service Connect (introduced in 2022) handles app→embedder discovery: both
# services join the same namespace, the embedder advertises itself as
# `embedder` on port 8080, and the app talks to `http://embedder:8080` like
# it does in docker-compose. No Route53 records, no Cloud Map manual
# wiring, no sidecar plumbing in the app image.
#
# The migrator runs as a task definition with no service — operators invoke
# it via `aws ecs run-task` after a fresh deploy (see README).
# -----------------------------------------------------------------------------

# ---- Cluster + Service Connect namespace ----

resource "aws_service_discovery_http_namespace" "this" {
  name        = local.service_connect_namespace
  description = "Service Connect namespace for ${var.name_prefix}"
  tags        = local.tags
}

resource "aws_ecs_cluster" "this" {
  name = var.name_prefix

  service_connect_defaults {
    namespace = aws_service_discovery_http_namespace.this.arn
  }

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = local.tags
}

resource "aws_ecs_cluster_capacity_providers" "this" {
  cluster_name       = aws_ecs_cluster.this.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
    base              = 1
  }
}

# ---- Shared env block (non-secret) for app + migrator ----

locals {
  app_environment = [
    { name = "NODE_ENV", value = "production" },
    { name = "LOG_LEVEL", value = var.log_level },
    { name = "PUBLIC_URL", value = local.public_url },
    { name = "AUTH_URL", value = local.public_url },
    { name = "AUTH_TRUST_HOST", value = "true" },
    { name = "OIDC_ISSUER", value = var.oidc_issuer },
    { name = "OIDC_CLIENT_ID_WEB", value = var.oidc_client_id_web },
    { name = "OIDC_CLIENT_ID_MCP", value = var.oidc_client_id_mcp },
    { name = "OIDC_AUDIENCE", value = var.oidc_audience },
    { name = "EMBEDDER_URL", value = "http://embedder:${local.embedder_port}" },
    { name = "EMBEDDING_MODEL", value = var.embedding_model },
    { name = "EMBEDDING_DIM", value = tostring(var.embedding_dim) },
  ]

  # `secrets` block format that ECS expects: name = env-var name, valueFrom
  # = secret ARN. ECS resolves these to env vars at task start.
  app_secrets = [
    { name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.database_url.arn },
    { name = "NEXTAUTH_SECRET", valueFrom = aws_secretsmanager_secret.nextauth_secret.arn },
    { name = "CLI_TOKEN_SECRET", valueFrom = aws_secretsmanager_secret.cli_token_secret.arn },
    { name = "OIDC_CLIENT_SECRET_WEB", valueFrom = aws_secretsmanager_secret.oidc_client_secret_web.arn },
  ]

  embedder_environment = [
    { name = "LOG_LEVEL", value = var.log_level },
    { name = "EMBEDDING_MODEL", value = var.embedding_model },
    { name = "EMBEDDING_DIM", value = tostring(var.embedding_dim) },
    { name = "MODEL_CACHE_DIR", value = "/data/models" },
  ]

  # Migrator needs only the DB + embedder URL. EMBEDDER_URL is what triggers
  # the post-migration backfill loop in scripts/migrate.ts.
  migrator_environment = [
    { name = "NODE_ENV", value = "production" },
    { name = "LOG_LEVEL", value = var.log_level },
    { name = "EMBEDDER_URL", value = "http://embedder:${local.embedder_port}" },
  ]

  migrator_secrets = [
    { name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.database_url.arn },
  ]
}

# ---- App task definition ----

resource "aws_ecs_task_definition" "app" {
  family                   = "${var.name_prefix}-app"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = var.app_cpu
  memory                   = var.app_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.app_task.arn

  container_definitions = jsonencode([
    {
      name      = "app"
      image     = var.app_image
      essential = true

      portMappings = [
        {
          name          = "app"
          containerPort = local.app_port
          hostPort      = local.app_port
          protocol      = "tcp"
          appProtocol   = "http"
        },
      ]

      environment = local.app_environment
      secrets     = local.app_secrets

      # Mirrors the Dockerfile healthcheck — keeps individual tasks honest
      # even before ALB health checks notice a problem.
      healthCheck = {
        command     = ["CMD-SHELL", "wget -q -O /dev/null http://localhost:${local.app_port}/api/health || exit 1"]
        interval    = 15
        timeout     = 5
        retries     = 5
        startPeriod = 30
      }

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.app.name
          awslogs-region        = data.aws_region.current.name
          awslogs-stream-prefix = "app"
        }
      }
    },
  ])

  tags = local.tags
}

# ---- Embedder task definition ----

resource "aws_ecs_task_definition" "embedder" {
  family                   = "${var.name_prefix}-embedder"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = var.embedder_cpu
  memory                   = var.embedder_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.embedder_task.arn

  # EFS-backed volume for the model cache.
  volume {
    name = "models"

    efs_volume_configuration {
      file_system_id     = aws_efs_file_system.embedder_models.id
      transit_encryption = "ENABLED"

      authorization_config {
        access_point_id = aws_efs_access_point.embedder_models.id
        iam             = "DISABLED"
      }
    }
  }

  container_definitions = jsonencode([
    {
      name      = "embedder"
      image     = var.embedder_image
      essential = true

      portMappings = [
        {
          name          = "embedder"
          containerPort = local.embedder_port
          hostPort      = local.embedder_port
          protocol      = "tcp"
          appProtocol   = "http"
        },
      ]

      environment = local.embedder_environment

      mountPoints = [
        {
          sourceVolume  = "models"
          containerPath = "/data/models"
          readOnly      = false
        },
      ]

      # 180s start period mirrors the Dockerfile — first boot has to load
      # (and on a cold EFS, download) the model.
      healthCheck = {
        command     = ["CMD-SHELL", "wget -q -O - http://127.0.0.1:${local.embedder_port}/health | grep -q '\"ready\":true' || exit 1"]
        interval    = 15
        timeout     = 5
        retries     = 8
        startPeriod = 180
      }

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.embedder.name
          awslogs-region        = data.aws_region.current.name
          awslogs-stream-prefix = "embedder"
        }
      }
    },
  ])

  tags = local.tags
}

# ---- Migrator task definition (no service — one-shot via `aws ecs run-task`) ----

resource "aws_ecs_task_definition" "migrator" {
  family                   = "${var.name_prefix}-migrator"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = var.migrator_cpu
  memory                   = var.migrator_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.migrator_task.arn

  container_definitions = jsonencode([
    {
      name      = "migrator"
      image     = var.app_image # same web image — runs migrate.mjs instead of server.js
      essential = true

      # Override the image's CMD to run the bundled migrator. Mirrors the
      # docker-compose migrator service.
      command = ["node", "apps/web/migrate.mjs"]

      environment = local.migrator_environment
      secrets     = local.migrator_secrets

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.migrator.name
          awslogs-region        = data.aws_region.current.name
          awslogs-stream-prefix = "migrator"
        }
      }
    },
  ])

  tags = local.tags
}

# ---- Services ----

# Embedder is created first because the app's Service Connect client config
# references the namespace, not the embedder service ARN — but starting the
# embedder first lets the app pass its DNS health probes immediately on first
# deploy.
resource "aws_ecs_service" "embedder" {
  name                   = "${var.name_prefix}-embedder"
  cluster                = aws_ecs_cluster.this.id
  task_definition        = aws_ecs_task_definition.embedder.arn
  desired_count          = var.embedder_desired_count
  launch_type            = "FARGATE"
  enable_execute_command = true

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [aws_security_group.embedder.id]
    assign_public_ip = false
  }

  service_connect_configuration {
    enabled   = true
    namespace = aws_service_discovery_http_namespace.this.arn

    # The app reaches this via `embedder:8080`. portName matches the
    # portMappings entry in the task def; discoveryName is the DNS label.
    service {
      port_name      = "embedder"
      discovery_name = "embedder"

      client_alias {
        port     = local.embedder_port
        dns_name = "embedder"
      }
    }

    log_configuration {
      log_driver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.service_connect.name
        awslogs-region        = data.aws_region.current.name
        awslogs-stream-prefix = "embedder-sc"
      }
    }
  }

  # Cold-start tolerance: the model load can take ~180s, so don't let ECS
  # mark the task unhealthy from its perspective during that window.
  health_check_grace_period_seconds = 240

  deployment_minimum_healthy_percent = 50
  deployment_maximum_percent         = 200

  tags = local.tags
}

resource "aws_ecs_service" "app" {
  name                   = "${var.name_prefix}-app"
  cluster                = aws_ecs_cluster.this.id
  task_definition        = aws_ecs_task_definition.app.arn
  desired_count          = var.app_desired_count
  launch_type            = "FARGATE"
  enable_execute_command = true

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.app.arn
    container_name   = "app"
    container_port   = local.app_port
  }

  service_connect_configuration {
    enabled   = true
    namespace = aws_service_discovery_http_namespace.this.arn

    log_configuration {
      log_driver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.service_connect.name
        awslogs-region        = data.aws_region.current.name
        awslogs-stream-prefix = "app-sc"
      }
    }
  }

  health_check_grace_period_seconds = 60

  deployment_minimum_healthy_percent = 50
  deployment_maximum_percent         = 200

  # The HTTPS listener must exist before the service tries to attach to the
  # target group — otherwise the first apply races.
  depends_on = [aws_lb_listener.https]

  tags = local.tags
}
