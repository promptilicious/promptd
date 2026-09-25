data "aws_ssm_parameter" "al2023_arm64" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
}

resource "aws_eip" "hub" {
  domain = "vpc"

  tags = { Name = "${var.name}-hub" }
}

resource "aws_ebs_volume" "data" {
  availability_zone = aws_subnet.public.availability_zone
  size              = var.data_volume_size_gb
  type              = "gp3"
  encrypted         = true

  tags = { Name = "${var.name}-data" }

  # Holds the database and every run log.
  lifecycle { prevent_destroy = true }
}

resource "aws_instance" "hub" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.value
  instance_type          = var.instance_type
  subnet_id              = aws_subnet.public.id
  vpc_security_group_ids = [aws_security_group.hub.id]
  iam_instance_profile   = aws_iam_instance_profile.hub.name

  metadata_options {
    http_tokens = "required"
  }

  root_block_device {
    volume_size = 20
    volume_type = "gp3"
    encrypted   = true
  }

  user_data = templatefile("${path.module}/../cloud-init/user-data.sh.tftpl", {
    name         = var.name
    aws_region   = var.region
    ssm_prefix   = local.ssm_prefix
    ecr_registry = "${local.account_id}.dkr.ecr.${var.region}.amazonaws.com"
    ecr_repo     = aws_ecr_repository.hub.name
    domain_name  = var.domain_name
    acme_email   = var.acme_email
  })
  user_data_replace_on_change = true

  tags = { Name = "${var.name}-hub" }

  depends_on = [aws_iam_role_policy_attachment.hub_ssm]
}

resource "aws_volume_attachment" "data" {
  device_name                    = "/dev/sdf"
  volume_id                      = aws_ebs_volume.data.id
  instance_id                    = aws_instance.hub.id
  stop_instance_before_detaching = true
}

resource "aws_eip_association" "hub" {
  instance_id   = aws_instance.hub.id
  allocation_id = aws_eip.hub.id
}
