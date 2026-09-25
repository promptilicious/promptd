output "state_bucket" {
  description = "Pass to the main module's terraform init as -backend-config=\"bucket=...\"."
  value       = aws_s3_bucket.tfstate.bucket
}

output "lock_table" {
  description = "Pass to the main module's terraform init as -backend-config=\"dynamodb_table=...\"."
  value       = aws_dynamodb_table.tfstate_lock.name
}
