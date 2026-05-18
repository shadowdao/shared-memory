# -----------------------------------------------------------------------------
# Outputs.
#
# Designed to give the operator everything they need to:
#   * point DNS at the ALB
#   * run the migrator one-shot
#   * extend the RDS security group with task ingress
#   * tail logs
# -----------------------------------------------------------------------------

output "alb_dns_name" {
  description = "ALB DNS name. Create a Route53 alias record pointing var.domain_name at this."
  value       = aws_lb.this.dns_name
}

output "alb_zone_id" {
  description = "ALB hosted zone ID, used as `alias.zone_id` on aws_route53_record."
  value       = aws_lb.this.zone_id
}

output "ecs_cluster_arn" {
  description = "ECS cluster ARN."
  value       = aws_ecs_cluster.this.arn
}

output "ecs_cluster_name" {
  description = "ECS cluster name. Pass to `aws ecs run-task --cluster`."
  value       = aws_ecs_cluster.this.name
}

output "app_service_name" {
  description = "App ECS service name."
  value       = aws_ecs_service.app.name
}

output "embedder_service_name" {
  description = "Embedder ECS service name."
  value       = aws_ecs_service.embedder.name
}

output "migrator_task_definition_arn" {
  description = "Migrator task definition ARN. Use with `aws ecs run-task --task-definition`."
  value       = aws_ecs_task_definition.migrator.arn
}

output "migrator_task_definition_family" {
  description = "Migrator task definition family — accepts the latest revision automatically when passed to `aws ecs run-task`."
  value       = aws_ecs_task_definition.migrator.family
}

output "app_log_group_name" {
  description = "CloudWatch log group for the app service."
  value       = aws_cloudwatch_log_group.app.name
}

output "embedder_log_group_name" {
  description = "CloudWatch log group for the embedder service."
  value       = aws_cloudwatch_log_group.embedder.name
}

output "migrator_log_group_name" {
  description = "CloudWatch log group for the migrator one-shot task."
  value       = aws_cloudwatch_log_group.migrator.name
}

output "app_security_group_id" {
  description = "Security group attached to app tasks. Add this as a source on your RDS SG inbound rule for port 5432."
  value       = aws_security_group.app.id
}

output "embedder_security_group_id" {
  description = "Security group attached to embedder tasks. Embedder doesn't hit RDS today, but expose for symmetry."
  value       = aws_security_group.embedder.id
}

output "migrator_security_group_id" {
  description = "Security group attached to the migrator one-shot. Must be allowed inbound on your RDS SG (5432) — this is what runs SQL migrations."
  value       = aws_security_group.migrator.id
}

output "private_subnet_ids_for_run_task" {
  description = "Echo of var.private_subnet_ids so `aws ecs run-task --network-configuration` can be assembled without re-typing them."
  value       = var.private_subnet_ids
}

output "secret_arns" {
  description = "Map of env-var name to Secrets Manager ARN. For visibility only — do not re-feed back into the module."
  value       = local.secret_arns
}
