data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"] # Canonical

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

resource "aws_security_group" "instances" {
  name_prefix = "happycmdb-${var.name_prefix}-${var.environment}-"
  description = "Security group for ${var.name_prefix} instances"
  vpc_id      = var.vpc_id

  ingress {
    from_port       = 7474
    to_port         = 7474
    protocol        = "tcp"
    security_groups = var.allowed_security_groups
    description     = "Neo4j HTTP"
  }

  ingress {
    from_port       = 7687
    to_port         = 7687
    protocol        = "tcp"
    security_groups = var.allowed_security_groups
    description     = "Neo4j Bolt"
  }

  ingress {
    from_port = 5000
    to_port   = 5000
    protocol  = "tcp"
    self      = true
    description = "Neo4j cluster discovery"
  }

  ingress {
    from_port = 6000
    to_port   = 6000
    protocol  = "tcp"
    self      = true
    description = "Neo4j cluster transaction"
  }

  ingress {
    from_port = 7000
    to_port   = 7000
    protocol  = "tcp"
    self      = true
    description = "Neo4j cluster raft"
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
    description = "All outbound"
  }

  tags = {
    Name        = "happycmdb-${var.name_prefix}-sg-${var.environment}"
    Environment = var.environment
  }
}

resource "aws_iam_role" "instances" {
  name_prefix = "happycmdb-${var.name_prefix}-${var.environment}-"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ec2.amazonaws.com"
        }
      }
    ]
  })

  tags = {
    Name        = "happycmdb-${var.name_prefix}-role-${var.environment}"
    Environment = var.environment
  }
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.instances.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "instances" {
  name_prefix = "happycmdb-${var.name_prefix}-${var.environment}-"
  role        = aws_iam_role.instances.name
}

resource "aws_instance" "instances" {
  count = var.instance_count

  ami           = data.aws_ami.ubuntu.id
  instance_type = var.instance_type
  subnet_id     = var.subnet_ids[count.index % length(var.subnet_ids)]

  vpc_security_group_ids = [aws_security_group.instances.id]
  iam_instance_profile   = aws_iam_instance_profile.instances.name

  user_data = var.user_data_template

  root_block_device {
    volume_type           = "gp3"
    volume_size           = 100
    iops                  = 3000
    throughput            = 125
    encrypted             = true
    delete_on_termination = true
  }

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  tags = {
    Name        = "happycmdb-${var.name_prefix}-${count.index + 1}-${var.environment}"
    Environment = var.environment
    Cluster     = var.name_prefix
  }
}

output "instance_ids" {
  value = aws_instance.instances[*].id
}

output "private_ips" {
  value = aws_instance.instances[*].private_ip
}
