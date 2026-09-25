# Terraform makes the slots; the values are set with `aws ssm put-parameter`
# (see infra/DEPLOY.md) so they never sit in git or in state.

resource "aws_ssm_parameter" "admin_password_hash" {
  name        = "${local.ssm_prefix}/PROMPTD_ADMIN_PASSWORD_HASH"
  description = "Hash of the web page's admin password, from npm run set-password -- --print-hash."
  type        = "SecureString"
  value       = "placeholder-set-out-of-band"

  lifecycle { ignore_changes = [value] }
}

resource "aws_ssm_parameter" "session_secret" {
  name        = "${local.ssm_prefix}/SESSION_SECRET"
  description = "Signs the session cookie. 32 characters or more."
  type        = "SecureString"
  value       = "placeholder-set-out-of-band"

  lifecycle { ignore_changes = [value] }
}

resource "aws_ssm_parameter" "node_token" {
  name        = "${local.ssm_prefix}/PROMPTD_NODE_TOKEN"
  description = "The token every node presents to the hub."
  type        = "SecureString"
  value       = "placeholder-set-out-of-band"

  lifecycle { ignore_changes = [value] }
}

resource "aws_ssm_parameter" "image_tag" {
  name        = "${local.ssm_prefix}/IMAGE_TAG"
  description = "The hub image tag deployed now. The deploy workflow rolls it; deploy.sh reads it."
  type        = "String"
  value       = "bootstrap"

  lifecycle { ignore_changes = [value] }
}
