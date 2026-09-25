terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
  }

  # The bucket, lock table and profile are yours, so they are supplied at init
  # with -backend-config rather than written here. See infra/DEPLOY.md.
  backend "s3" {
    key     = "promptd/main.tfstate"
    encrypt = true
  }
}

provider "aws" {
  region  = var.region
  profile = var.aws_profile

  default_tags {
    tags = {
      Project   = var.name
      ManagedBy = "terraform"
    }
  }
}

data "aws_caller_identity" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  ssm_prefix = "/${var.name}/prod"
}
