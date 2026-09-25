output "hub_ip" {
  description = "Point an A record for domain_name at this, DNS only (not proxied)."
  value       = aws_eip.hub.public_ip
}

output "hub_instance_id" {
  description = "Repository variable EC2_INSTANCE_ID, and the target for SSM sessions."
  value       = aws_instance.hub.id
}

output "ecr_repository" {
  description = "Repository variable ECR_REPOSITORY."
  value       = aws_ecr_repository.hub.name
}

output "ecr_repository_url" {
  description = "Where the first image is pushed from your machine."
  value       = aws_ecr_repository.hub.repository_url
}

output "github_deploy_role_arn" {
  description = "Repository variable AWS_ROLE_ARN."
  value       = aws_iam_role.github_deploy.arn
}

output "ssm_prefix" {
  description = "Repository variable SSM_PREFIX; the hub reads its secrets from here."
  value       = local.ssm_prefix
}

output "hub_url" {
  description = "Repository variable HUB_URL, and the HUB_URL a node registers with."
  value       = "https://${var.domain_name}"
}

output "hub_nameservers" {
  description = "With manage_dns on: add these as NS records for domain_name at your parent domain's DNS."
  value       = var.manage_dns ? aws_route53_zone.hub[0].name_servers : []
}
