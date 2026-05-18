# -----------------------------------------------------------------------------
# Application Load Balancer.
#
#   * Internet-facing, in the public subnets
#   * HTTP listener on :80 returns a 301 to https://${domain}${path}
#   * HTTPS listener on :443 terminates TLS with the user's ACM cert and
#     forwards to the app target group on 3000
#
# Target type is `ip` because Fargate tasks register their ENI IPs directly,
# not via an EC2 instance.
# -----------------------------------------------------------------------------

resource "aws_lb" "this" {
  name               = "${var.name_prefix}-alb"
  load_balancer_type = "application"
  internal           = false
  subnets            = var.public_subnet_ids
  security_groups    = [aws_security_group.alb.id]

  # Keep HTTP/2 on (default) so MCP streaming works smoothly. drop_invalid
  # headers protects against header smuggling against the upstream.
  drop_invalid_header_fields = true

  tags = merge(local.tags, { Name = "${var.name_prefix}-alb" })
}

resource "aws_lb_target_group" "app" {
  name                 = "${var.name_prefix}-app"
  port                 = local.app_port
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = var.vpc_id
  deregistration_delay = 30

  health_check {
    enabled             = true
    path                = "/api/health"
    port                = "traffic-port"
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  tags = local.tags
}

# Port 80 → 301 redirect to HTTPS.
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"

    redirect {
      protocol    = "HTTPS"
      port        = "443"
      status_code = "HTTP_301"
    }
  }

  tags = local.tags
}

# Port 443 → app target group. TLS terminates at the ALB; the app speaks
# plain HTTP behind it. PUBLIC_URL teaches Auth.js and the MCP route that
# the public origin is HTTPS regardless.
resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.acm_certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }

  tags = local.tags
}
