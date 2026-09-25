resource "aws_route53_zone" "hub" {
  count   = var.manage_dns ? 1 : 0
  name    = var.domain_name
  comment = "Delegated from the parent domain's DNS; see infra/DEPLOY.md."
}

resource "aws_route53_record" "hub" {
  count   = var.manage_dns ? 1 : 0
  zone_id = aws_route53_zone.hub[0].zone_id
  name    = var.domain_name
  type    = "A"
  ttl     = 300
  records = [aws_eip.hub.public_ip]
}
