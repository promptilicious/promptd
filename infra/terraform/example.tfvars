# Copy to terraform.tfvars (git-ignored) and fill in your own values.
aws_profile  = "promptd-admin"
region       = "us-east-1"
name         = "promptd"
domain_name  = "promptd.example.com"
acme_email   = "you@example.com"
github_owner = "your-github-user-or-org"
github_repo  = "promptd"

# Set false when this AWS account already has a GitHub OIDC provider.
create_github_oidc_provider = true

# true: Terraform creates a Route 53 zone for domain_name, and you delegate to it.
# false: you add an A record for domain_name yourself, pointing at hub_ip.
manage_dns = false
