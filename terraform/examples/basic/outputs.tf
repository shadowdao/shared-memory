# Surface the module outputs so `terraform output` from this directory
# gives the operator everything they need without diving into the module.

output "alb_dns_name" {
  description = "Point your Route53 record (alias) at this."
  value       = module.shared_memory.alb_dns_name
}

output "alb_zone_id" {
  description = "Used as alias.zone_id on aws_route53_record."
  value       = module.shared_memory.alb_zone_id
}

output "ecs_cluster_name" {
  description = "Pass to `aws ecs run-task --cluster`."
  value       = module.shared_memory.ecs_cluster_name
}

output "migrator_task_definition_family" {
  description = "Pass to `aws ecs run-task --task-definition`."
  value       = module.shared_memory.migrator_task_definition_family
}

output "migrator_security_group_id" {
  description = "Whitelist on RDS SG (inbound 5432)."
  value       = module.shared_memory.migrator_security_group_id
}

output "app_security_group_id" {
  description = "Whitelist on RDS SG (inbound 5432)."
  value       = module.shared_memory.app_security_group_id
}

output "private_subnet_ids" {
  description = "Echoed from input — handy for `aws ecs run-task --network-configuration`."
  value       = module.shared_memory.private_subnet_ids_for_run_task
}

output "app_log_group_name" {
  value = module.shared_memory.app_log_group_name
}

output "embedder_log_group_name" {
  value = module.shared_memory.embedder_log_group_name
}

output "migrator_log_group_name" {
  value = module.shared_memory.migrator_log_group_name
}

output "secret_arns" {
  description = "Visibility into where the module stored its secrets."
  value       = module.shared_memory.secret_arns
  sensitive   = true
}
