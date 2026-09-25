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
