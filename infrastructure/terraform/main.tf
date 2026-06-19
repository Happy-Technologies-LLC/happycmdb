terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  backend "s3" {
    bucket         = "happycmdb-terraform-state"
    key            = "prod/terraform.tfstate"
    region         = "us-east-1"
    encrypt        = true
    dynamodb_table = "terraform-state-lock"
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "HappyCMDB-CMDB"
      Environment = var.environment
      ManagedBy   = "Terraform"
    }
  }
}

# VPC Module
module "vpc" {
  source = "./modules/vpc"

  environment         = var.environment
  vpc_cidr            = var.vpc_cidr
  availability_zones  = var.availability_zones
  private_subnets     = var.private_subnets
  public_subnets      = var.public_subnets
  database_subnets    = var.database_subnets
}

# RDS PostgreSQL Module
module "rds" {
  source = "./modules/rds"

  environment             = var.environment
  vpc_id                  = module.vpc.vpc_id
  database_subnet_ids     = module.vpc.database_subnet_ids
  allowed_security_groups = [module.vpc.app_security_group_id]

  instance_class          = var.rds_instance_class
  allocated_storage       = var.rds_allocated_storage
  max_allocated_storage   = var.rds_max_allocated_storage
  multi_az                = var.rds_multi_az
  backup_retention_period = var.rds_backup_retention_period
}

# ElastiCache Redis Module
module "elasticache" {
  source = "./modules/elasticache"

  environment             = var.environment
  vpc_id                  = module.vpc.vpc_id
  subnet_ids              = module.vpc.private_subnet_ids
  allowed_security_groups = [module.vpc.app_security_group_id]

  node_type               = var.redis_node_type
  num_cache_clusters      = var.redis_num_nodes
  automatic_failover      = var.redis_automatic_failover
}

# MSK Kafka Module
module "msk" {
  source = "./modules/msk"

  environment             = var.environment
  vpc_id                  = module.vpc.vpc_id
  subnet_ids              = module.vpc.private_subnet_ids
  allowed_security_groups = [module.vpc.app_security_group_id]

  instance_type           = var.kafka_instance_type
  number_of_brokers       = var.kafka_number_of_brokers
  kafka_version           = var.kafka_version
  ebs_volume_size         = var.kafka_ebs_volume_size
}

# EC2 Instances for Neo4j Cluster
module "neo4j_cluster" {
  source = "./modules/ec2"

  environment             = var.environment
  vpc_id                  = module.vpc.vpc_id
  subnet_ids              = module.vpc.private_subnet_ids
  allowed_security_groups = [module.vpc.app_security_group_id]

  instance_type           = var.neo4j_instance_type
  instance_count          = 3
  name_prefix             = "neo4j-cluster"
  user_data_template      = file("${path.module}/scripts/neo4j-user-data.sh")
}

# IAM Roles and Policies
module "iam" {
  source = "./modules/iam"

  environment = var.environment
}

# S3 Buckets for Backups
module "s3" {
  source = "./modules/s3"

  environment = var.environment
  backup_retention_days = var.backup_retention_days
}

# Outputs
output "vpc_id" {
  value       = module.vpc.vpc_id
  description = "VPC ID"
}

output "rds_endpoint" {
  value       = module.rds.endpoint
  description = "RDS PostgreSQL endpoint"
  sensitive   = true
}

output "elasticache_endpoint" {
  value       = module.elasticache.configuration_endpoint
  description = "ElastiCache Redis cluster endpoint"
  sensitive   = true
}

output "msk_bootstrap_brokers" {
  value       = module.msk.bootstrap_brokers
  description = "MSK Kafka bootstrap brokers"
}

output "neo4j_instance_ips" {
  value       = module.neo4j_cluster.private_ips
  description = "Neo4j cluster private IPs"
}

output "backup_bucket" {
  value       = module.s3.backup_bucket_name
  description = "S3 backup bucket name"
}
