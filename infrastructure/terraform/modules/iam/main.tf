resource "aws_iam_role" "app_role" {
  name_prefix = "happycmdb-app-${var.environment}-"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = ["ec2.amazonaws.com", "ecs-tasks.amazonaws.com"]
        }
      }
    ]
  })

  tags = {
    Name        = "happycmdb-app-role-${var.environment}"
    Environment = var.environment
  }
}

resource "aws_iam_role_policy" "app_policy" {
  name_prefix = "happycmdb-app-policy-${var.environment}-"
  role        = aws_iam_role.app_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:ListBucket"
        ]
        Resource = [
          "arn:aws:s3:::happycmdb-backups-${var.environment}/*",
          "arn:aws:s3:::happycmdb-backups-${var.environment}"
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue"
        ]
        Resource = [
          "arn:aws:secretsmanager:*:*:secret:happycmdb-*"
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "cloudwatch:PutMetricData"
        ]
        Resource = "*"
      }
    ]
  })
}

output "app_role_arn" {
  value = aws_iam_role.app_role.arn
}
