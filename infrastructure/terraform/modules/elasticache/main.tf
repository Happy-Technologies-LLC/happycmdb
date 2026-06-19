resource "aws_elasticache_subnet_group" "main" {
  name       = "happycmdb-redis-${var.environment}"
  subnet_ids = var.subnet_ids

  tags = {
    Name        = "happycmdb-redis-subnet-group-${var.environment}"
    Environment = var.environment
  }
}

resource "aws_security_group" "redis" {
  name_prefix = "happycmdb-redis-${var.environment}-"
  description = "Security group for ElastiCache Redis"
  vpc_id      = var.vpc_id

  ingress {
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = var.allowed_security_groups
    description     = "Redis access from app servers"
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
    description = "All outbound"
  }

  tags = {
    Name        = "happycmdb-redis-sg-${var.environment}"
    Environment = var.environment
  }
}

resource "random_password" "auth_token" {
  length  = 32
  special = false
}

resource "aws_secretsmanager_secret" "redis_auth_token" {
  name_prefix = "happycmdb-redis-token-${var.environment}-"
  description = "Redis authentication token"

  tags = {
    Environment = var.environment
  }
}

resource "aws_secretsmanager_secret_version" "redis_auth_token" {
  secret_id     = aws_secretsmanager_secret.redis_auth_token.id
  secret_string = random_password.auth_token.result
}

resource "aws_elasticache_replication_group" "main" {
  replication_group_id       = "happycmdb-redis-${var.environment}"
  replication_group_description = "HappyCMDB Redis cluster"

  engine               = "redis"
  engine_version       = "7.1"
  node_type            = var.node_type
  num_cache_clusters   = var.num_cache_clusters
  parameter_group_name = "default.redis7.cluster.on"
  port                 = 6379

  subnet_group_name          = aws_elasticache_subnet_group.main.name
  security_group_ids         = [aws_security_group.redis.id]
  auth_token                 = random_password.auth_token.result
  transit_encryption_enabled = true
  at_rest_encryption_enabled = true

  automatic_failover_enabled = var.automatic_failover
  multi_az_enabled           = var.automatic_failover

  snapshot_retention_limit = 7
  snapshot_window          = "03:00-05:00"
  maintenance_window       = "sun:05:00-sun:07:00"

  log_delivery_configuration {
    destination      = aws_cloudwatch_log_group.redis_slow_log.name
    destination_type = "cloudwatch-logs"
    log_format       = "json"
    log_type         = "slow-log"
  }

  tags = {
    Name        = "happycmdb-redis-${var.environment}"
    Environment = var.environment
  }
}

resource "aws_cloudwatch_log_group" "redis_slow_log" {
  name              = "/aws/elasticache/happycmdb-redis-${var.environment}/slow-log"
  retention_in_days = 7

  tags = {
    Environment = var.environment
  }
}

output "configuration_endpoint" {
  value = aws_elasticache_replication_group.main.configuration_endpoint_address
}

output "auth_token_secret_arn" {
  value = aws_secretsmanager_secret.redis_auth_token.arn
}
