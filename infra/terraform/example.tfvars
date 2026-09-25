# Copy to terraform.tfvars (git-ignored) and fill in your own values.
aws_profile = "promptd-admin"
region      = "us-east-1"
name        = "promptd"
domain_name = "promptd.example.com"
acme_email  = "you@example.com"

# true: Terraform creates a Route 53 zone for domain_name, and you delegate to it.
# false: you add an A record for domain_name yourself, pointing at hub_ip.
manage_dns = false
