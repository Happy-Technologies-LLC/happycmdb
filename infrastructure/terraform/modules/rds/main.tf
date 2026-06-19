resource "aws_db_subnet_group" "main" {
  name_prefix = "happycmdb-rds-${var.environment}-"
  subnet_ids  = var.database_subnet_ids

  tags = {
    Name        = "happycmdb-rds-subnet-group-${var.environment}"
    Environment = var.environment
  }
}

resource "aws_security_group" "rds" {
  name_prefix = "happycmdb-rds-${var.environment}-"
  description = "Security group for RDS PostgreSQL"
  vpc_id      = var.vpc_id

  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = var.allowed_security_groups
    description     = "PostgreSQL access from app servers"
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
    description = "All outbound"
  }

  tags = {
    Name        = "happycmdb-rds-sg-${var.environment}"
    Environment = var.environment
  }
}

resource "random_password" "master" {
  length  = 32
  special = true
}

resource "aws_secretsmanager_secret" "rds_password" {
  name_prefix = "happycmdb-rds-password-${var.environment}-"
  description = "RDS PostgreSQL master password"

  tags = {
    Environment = var.environment
  }
}

resource "aws_secretsmanager_secret_version" "rds_password" {
  secret_id     = aws_secretsmanager_secret.rds_password.id
  secret_string = random_password.master.result
}

resource "aws_db_instance" "main" {
  identifier     = "happycmdb-postgres-${var.environment}"
  engine         = "postgres"
  engine_version = "16.1"
  instance_class = var.instance_class

  allocated_storage     = var.allocated_storage
  max_allocated_storage = var.max_allocated_storage
  storage_type          = "gp3"
  storage_encrypted     = true
  iops                  = 3000

  db_name  = "cmdb"
  username = "cmdb_admin"
  password = random_password.master.result

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]

  multi_az               = var.multi_az
  backup_retention_period = var.backup_retention_period
  backup_window          = "03:00-04:00"
  maintenance_window     = "mon:04:00-mon:05:00"

  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]
  performance_insights_enabled    = true
  performance_insights_retention_period = 7

  deletion_protection = true
  skip_final_snapshot = false
  final_snapshot_identifier = "happycmdb-postgres-${var.environment}-final-${formatdate("YYYY-MM-DD-hhmm", timestamp())}"

  tags = {
    Name        = "happycmdb-postgres-${var.environment}"
    Environment = var.environment
  }
}

output "endpoint" {
  value = aws_db_instance.main.endpoint
}

output "database_name" {
  value = aws_db_instance.main.db_name
}

output "username" {
  value = aws_db_instance.main.username
}

output "password_secret_arn" {
  value = aws_secretsmanager_secret.rds_password.arn
}
