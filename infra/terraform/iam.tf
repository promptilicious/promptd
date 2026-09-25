resource "aws_iam_role" "hub" {
  name = "${var.name}-hub"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "hub_ssm" {
  role       = aws_iam_role.hub.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "hub" {
  name = "${var.name}-hub"
  role = aws_iam_role.hub.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "EcrPull"
        Effect = "Allow"
        Action = [
          "ecr:GetAuthorizationToken",
          "ecr:BatchCheckLayerAvailability",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
        ]
        Resource = "*"
      },
      {
        Sid    = "ReadRuntimeConfig"
        Effect = "Allow"
        Action = ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"]
        # GetParametersByPath is checked against the path itself, GetParameter
        # against each parameter, so both forms are needed.
        Resource = [
          "arn:aws:ssm:${var.region}:${local.account_id}:parameter${local.ssm_prefix}",
          "arn:aws:ssm:${var.region}:${local.account_id}:parameter${local.ssm_prefix}/*",
        ]
      },
      {
        Sid      = "DecryptSecureStrings"
        Effect   = "Allow"
        Action   = "kms:Decrypt"
        Resource = "*"
        Condition = {
          StringEquals = { "kms:ViaService" = "ssm.${var.region}.amazonaws.com" }
        }
      },
    ]
  })
}

resource "aws_iam_instance_profile" "hub" {
  name = "${var.name}-hub"
  role = aws_iam_role.hub.name
}
