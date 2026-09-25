output "hub_ip" {
  description = "Point an A record for domain_name at this, DNS only (not proxied)."
  value       = aws_eip.hub.public_ip
}

output "hub_instance_id" {
  description = "The target for SSM sessions and scripts/deploy-hub.sh."
  value       = aws_instance.hub.id
}

output "ecr_repository" {
  description = "The ECR repository holding hub images."
  value       = aws_ecr_repository.hub.name
}

output "ecr_repository_url" {
  description = "Where the first image is pushed from your machine."
  value       = aws_ecr_repository.hub.repository_url
}

output "ssm_prefix" {
  description = "Where the hub reads its secrets and IMAGE_TAG."
  value       = local.ssm_prefix
}

output "hub_url" {
  description = "The address to open, and the HUB_URL a node registers with."
  value       = "https://${var.domain_name}"
}

output "hub_nameservers" {
  description = "With manage_dns on: add these as NS records for domain_name at your parent domain's DNS."
  value       = var.manage_dns ? aws_route53_zone.hub[0].name_servers : []
}

output "name" {
  description = "The resource prefix; deploy.sh lives in /opt/<name> on the host."
  value       = var.name
}

output "aws_region" {
  description = "Region scripts/deploy-hub.sh runs its AWS commands in."
  value       = var.region
}

output "aws_profile" {
  description = "Local AWS CLI profile scripts/deploy-hub.sh uses."
  value       = var.aws_profile
}
