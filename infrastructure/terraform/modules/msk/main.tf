resource "aws_security_group" "msk" {
  name_prefix = "happycmdb-msk-${var.environment}-"
  description = "Security group for MSK Kafka"
  vpc_id      = var.vpc_id

  ingress {
    from_port       = 9092
    to_port         = 9092
    protocol        = "tcp"
    security_groups = var.allowed_security_groups
    description     = "Kafka plaintext"
  }

  ingress {
    from_port       = 9094
    to_port         = 9094
    protocol        = "tcp"
    security_groups = var.allowed_security_groups
    description     = "Kafka TLS"
  }

  ingress {
    from_port = 0
    to_port   = 0
    protocol  = "-1"
    self      = true
    description = "Allow all inter-broker communication"
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
    description = "All outbound"
  }

  tags = {
    Name        = "happycmdb-msk-sg-${var.environment}"
    Environment = var.environment
  }
}

resource "aws_cloudwatch_log_group" "msk" {
  name              = "/aws/msk/happycmdb-${var.environment}"
  retention_in_days = 7

  tags = {
    Environment = var.environment
  }
}

resource "aws_msk_cluster" "main" {
  cluster_name           = "happycmdb-kafka-${var.environment}"
  kafka_version          = var.kafka_version
  number_of_broker_nodes = var.number_of_brokers

  broker_node_group_info {
    instance_type   = var.instance_type
    client_subnets  = var.subnet_ids
    security_groups = [aws_security_group.msk.id]

    storage_info {
      ebs_storage_info {
        volume_size            = var.ebs_volume_size
        provisioned_throughput {
          enabled           = true
          volume_throughput = 250
        }
      }
    }

    connectivity_info {
      public_access {
        type = "DISABLED"
      }
    }
  }

  encryption_info {
    encryption_in_transit {
      client_broker = "TLS"
      in_cluster    = true
    }
    encryption_at_rest_kms_key_arn = aws_kms_key.msk.arn
  }

  configuration_info {
    arn      = aws_msk_configuration.main.arn
    revision = aws_msk_configuration.main.latest_revision
  }

  logging_info {
    broker_logs {
      cloudwatch_logs {
        enabled   = true
        log_group = aws_cloudwatch_log_group.msk.name
      }
    }
  }

  tags = {
    Name        = "happycmdb-kafka-${var.environment}"
    Environment = var.environment
  }
}

resource "aws_msk_configuration" "main" {
  name              = "happycmdb-kafka-config-${var.environment}"
  kafka_versions    = [var.kafka_version]
  server_properties = <<PROPERTIES
auto.create.topics.enable=false
default.replication.factor=3
min.insync.replicas=2
num.partitions=6
log.retention.hours=168
log.segment.bytes=1073741824
PROPERTIES

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_kms_key" "msk" {
  description             = "KMS key for MSK encryption"
  deletion_window_in_days = 10

  tags = {
    Name        = "happycmdb-msk-kms-${var.environment}"
    Environment = var.environment
  }
}

resource "aws_kms_alias" "msk" {
  name          = "alias/happycmdb-msk-${var.environment}"
  target_key_id = aws_kms_key.msk.key_id
}

output "bootstrap_brokers" {
  value = aws_msk_cluster.main.bootstrap_brokers_tls
}

output "zookeeper_connect_string" {
  value = aws_msk_cluster.main.zookeeper_connect_string
}
