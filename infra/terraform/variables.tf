variable "aws_profile" {
  description = "Local AWS CLI profile to plan and apply with."
  type        = string
  default     = "promptd-admin"
}

variable "region" {
  description = "AWS region for everything in this module."
  type        = string
  default     = "us-east-1"
}

variable "name" {
  description = "Prefix for every resource name and the SSM path. Change it to run two hubs in one account."
  type        = string
  default     = "promptd"
}

variable "domain_name" {
  description = "Host name the hub is served on, e.g. promptd.example.com. You point its DNS at the hub_ip output."
  type        = string
}

variable "acme_email" {
  description = "Email Let's Encrypt uses for certificate expiry notices."
  type        = string
}

variable "instance_type" {
  description = "EC2 instance type. ARM64 (t4g) to match the image the workflow builds."
  type        = string
  default     = "t4g.small"
}

variable "data_volume_size_gb" {
  description = "Size of the volume holding the SQLite database and run logs."
  type        = number
  default     = 20
}

variable "backup_retention_days" {
  description = "How long daily snapshots of the data volume are kept."
  type        = number
  default     = 14
}

variable "manage_dns" {
  description = "Create a Route 53 zone for domain_name with its A record. You then delegate the name to the zone's nameservers. Leave false to add the A record yourself wherever your DNS lives."
  type        = bool
  default     = false
}
