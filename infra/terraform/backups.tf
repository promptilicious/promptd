resource "aws_backup_vault" "main" {
  name = "${var.name}-backups"
}

resource "aws_iam_role" "backup" {
  name = "${var.name}-backup"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "backup.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "backup" {
  role       = aws_iam_role.backup.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup"
}

resource "aws_backup_plan" "daily" {
  name = "${var.name}-daily"

  rule {
    rule_name         = "daily"
    target_vault_name = aws_backup_vault.main.name
    schedule          = "cron(0 7 * * ? *)"
    lifecycle {
      delete_after = var.backup_retention_days
    }
  }
}

resource "aws_backup_selection" "data" {
  iam_role_arn = aws_iam_role.backup.arn
  name         = "${var.name}-data"
  plan_id      = aws_backup_plan.daily.id
  resources    = [aws_ebs_volume.data.arn]
}
