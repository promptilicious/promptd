variable "aws_profile" {
  description = "Local AWS CLI profile with admin rights on the account you deploy to."
  type        = string
  default     = "promptd-admin"
}

variable "region" {
  description = "AWS region for the state bucket and lock table."
  type        = string
  default     = "us-east-1"
}

variable "name" {
  description = "Prefix for every resource name. Must match `name` in the main module."
  type        = string
  default     = "promptd"
}
