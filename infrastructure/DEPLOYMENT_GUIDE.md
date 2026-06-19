# HappyCMDB - Deployment Guide

## Quick Start Guides

### 1. Local Development with Docker Compose (5 minutes)

```bash
# Clone repository
git clone https://github.com/your-org/happycmdb.git
cd happycmdb

# Start services
docker-compose up -d

# Wait for services to be ready (2-3 minutes)
docker-compose ps

# Verify health
curl http://localhost:3000/api/v1/health

# Access services
# - API: http://localhost:3000
# - Neo4j Browser: http://localhost:7474
```

### 2. Production Docker Compose Deployment (15 minutes)

```bash
# Clone repository
git clone https://github.com/your-org/happycmdb.git
cd happycmdb

# Configure environment
cp .env.production .env
nano .env  # Update all passwords

# Start production stack
docker-compose -f docker-compose.prod.yml up -d

# Wait for all services (5-10 minutes)
docker-compose -f docker-compose.prod.yml ps

# Initialize databases
docker exec cmdb-neo4j-core-1 /infrastructure/scripts/init-neo4j-cluster.sh
docker exec cmdb-kafka-1 /infrastructure/scripts/init-kafka-topics.sh

# Verify cluster health
curl http://localhost:3000/api/v1/health | jq
```

### 3. Kubernetes Production Deployment (30 minutes)

```bash
# Prerequisites check
kubectl version
helm version

# Create namespace
kubectl apply -f infrastructure/kubernetes/namespace/

# Create secrets (IMPORTANT: Use strong passwords!)
kubectl create secret generic cmdb-secrets \
  --from-literal=neo4j-password='CHANGE_ME_STRONG_PASSWORD' \
  --from-literal=neo4j-auth='neo4j/CHANGE_ME_STRONG_PASSWORD' \
  --from-literal=postgres-user='cmdb_user' \
  --from-literal=postgres-password='CHANGE_ME_STRONG_PASSWORD' \
  --from-literal=redis-password='CHANGE_ME_STRONG_PASSWORD' \
  --namespace=happycmdb-cmdb

kubectl create secret generic cloud-credentials \
  --from-literal=aws-access-key-id='YOUR_AWS_KEY' \
  --from-literal=aws-secret-access-key='YOUR_AWS_SECRET' \
  --namespace=happycmdb-cmdb

# Deploy infrastructure
kubectl apply -f infrastructure/kubernetes/storage/
kubectl apply -f infrastructure/kubernetes/statefulsets/

# Wait for databases
kubectl wait --for=condition=ready pod -l app=neo4j -n happycmdb-cmdb --timeout=300s
kubectl wait --for=condition=ready pod -l app=postgres -n happycmdb-cmdb --timeout=300s
kubectl wait --for=condition=ready pod -l app=redis -n happycmdb-cmdb --timeout=300s

# Deploy application
kubectl apply -f infrastructure/kubernetes/configmaps/
kubectl apply -f infrastructure/kubernetes/deployments/
kubectl apply -f infrastructure/kubernetes/ingress/
kubectl apply -f infrastructure/kubernetes/hpa/

# Verify deployment
kubectl get pods -n happycmdb-cmdb
kubectl get svc -n happycmdb-cmdb
kubectl get ingress -n happycmdb-cmdb

# Check health
kubectl port-forward svc/api-server 3000:3000 -n happycmdb-cmdb
curl http://localhost:3000/api/v1/health
```

### 4. AWS Terraform Deployment (45 minutes)

```bash
# Prerequisites
aws configure  # Configure AWS credentials
terraform --version

# Create Terraform state bucket
aws s3 mb s3://happycmdb-terraform-state-$(aws sts get-caller-identity --query Account --output text) --region us-east-1

aws dynamodb create-table \
  --table-name terraform-state-lock \
  --attribute-definitions AttributeName=LockID,AttributeType=S \
  --key-schema AttributeName=LockID,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --region us-east-1

# Initialize Terraform
cd infrastructure/terraform
terraform init

# Create terraform.tfvars
cat > terraform.tfvars <<EOF
aws_region                   = "us-east-1"
environment                  = "production"
vpc_cidr                     = "10.0.0.0/16"
rds_instance_class           = "db.r6g.xlarge"
rds_multi_az                 = true
redis_node_type              = "cache.r6g.large"
redis_num_nodes              = 6
kafka_instance_type          = "kafka.m5.xlarge"
kafka_number_of_brokers      = 3
neo4j_instance_type          = "r6i.2xlarge"
backup_retention_days        = 90
EOF

# Plan and review
terraform plan -out=tfplan

# Apply (WARNING: This will create billable AWS resources!)
terraform apply tfplan

# Get outputs
terraform output

# SSH to Neo4j nodes and setup cluster
# (Instructions in outputs)
```

## Pre-Deployment Checklist

### Infrastructure Requirements

- [ ] Docker Engine 20.10+ installed (for Docker Compose)
- [ ] Kubernetes 1.27+ cluster available (for K8s deployment)
- [ ] AWS account with admin access (for Terraform)
- [ ] Sufficient resources:
  - [ ] 16GB+ RAM for development
  - [ ] 64GB+ RAM for production
  - [ ] 200GB+ disk space
  - [ ] Multi-core CPU (4+ cores recommended)

### Security Requirements

- [ ] Strong passwords generated for all services
- [ ] TLS certificates obtained (for production)
- [ ] Cloud credentials configured securely
- [ ] Firewall rules configured
- [ ] Network segmentation planned
- [ ] Backup strategy defined

### Access Requirements

- [ ] Docker Hub credentials (if using private images)
- [ ] AWS credentials configured
- [ ] kubectl configured with cluster access
- [ ] VPN/bastion host access (for production)

## Environment-Specific Configurations

### Development Environment

**Characteristics:**
- Single instance of each service
- Minimal resource allocation
- Ephemeral data (no backup requirement)
- Local Docker Compose deployment

**Configuration:**
```yaml
# Use docker-compose.yml
services:
  neo4j:
    image: neo4j:5.15-community
    deploy:
      resources:
        limits:
          memory: 2G
```

### Staging Environment

**Characteristics:**
- Production-like architecture
- Reduced resource allocation
- Regular backups
- Kubernetes or AWS deployment

**Configuration:**
```yaml
# Kubernetes with reduced replicas
replicas: 2  # Instead of 3
resources:
  limits:
    memory: 4Gi  # Instead of 6Gi
```

### Production Environment

**Characteristics:**
- Full high-availability setup
- Maximum resource allocation
- Automated backups and monitoring
- Multi-region (optional)

**Configuration:**
```yaml
# Full production specs from docker-compose.prod.yml
# or Kubernetes production manifests
```

## Step-by-Step Production Deployment

### Phase 1: Infrastructure Setup (Day 1)

#### 1.1 AWS Infrastructure (if using Terraform)

```bash
cd infrastructure/terraform

# Initialize
terraform init

# Create VPC and networking
terraform apply -target=module.vpc

# Create databases
terraform apply -target=module.rds
terraform apply -target=module.elasticache
terraform apply -target=module.msk

# Create compute
terraform apply -target=module.neo4j_cluster

# Apply everything
terraform apply
```

#### 1.2 Kubernetes Cluster (if using K8s)

```bash
# Create EKS cluster (example)
eksctl create cluster \
  --name happycmdb-prod \
  --version 1.28 \
  --region us-east-1 \
  --nodegroup-name standard-workers \
  --node-type r6i.2xlarge \
  --nodes 6 \
  --nodes-min 3 \
  --nodes-max 12 \
  --managed

# Install nginx-ingress
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx \
  --create-namespace

# Install cert-manager
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.13.0/cert-manager.yaml
```

### Phase 2: Database Deployment (Day 1-2)

#### 2.1 Deploy StatefulSets

```bash
kubectl apply -f infrastructure/kubernetes/storage/
kubectl apply -f infrastructure/kubernetes/statefulsets/neo4j-statefulset.yaml
kubectl apply -f infrastructure/kubernetes/statefulsets/postgresql-statefulset.yaml
kubectl apply -f infrastructure/kubernetes/statefulsets/zookeeper-statefulset.yaml
kubectl apply -f infrastructure/kubernetes/statefulsets/kafka-statefulset.yaml
kubectl apply -f infrastructure/kubernetes/statefulsets/redis-statefulset.yaml
```

#### 2.2 Wait for Ready State

```bash
# Monitor pod status
watch kubectl get pods -n happycmdb-cmdb

# Check PVCs
kubectl get pvc -n happycmdb-cmdb

# Verify services
kubectl get svc -n happycmdb-cmdb
```

#### 2.3 Initialize Databases

```bash
# Neo4j
kubectl exec -it neo4j-0 -n happycmdb-cmdb -- bash
/scripts/init-neo4j-cluster.sh

# Verify Neo4j cluster
kubectl exec neo4j-0 -n happycmdb-cmdb -- cypher-shell -u neo4j -p PASSWORD "CALL dbms.cluster.overview()"

# Kafka topics (wait for Job to complete)
kubectl get job redis-cluster-init -n happycmdb-cmdb
kubectl logs job/redis-cluster-init -n happycmdb-cmdb

# Initialize Kafka
kubectl exec kafka-0 -n happycmdb-cmdb -- /scripts/init-kafka-topics.sh
```

### Phase 3: Application Deployment (Day 2)

#### 3.1 Build and Push Docker Images

```bash
# Build images
docker build -f infrastructure/docker/Dockerfile.api -t happycmdb/api-server:v1.0.0 .
docker build -f infrastructure/docker/Dockerfile.discovery -t happycmdb/discovery-engine:v1.0.0 .
docker build -f infrastructure/docker/Dockerfile.etl -t happycmdb/etl-processor:v1.0.0 .

# Push to registry
docker push happycmdb/api-server:v1.0.0
docker push happycmdb/discovery-engine:v1.0.0
docker push happycmdb/etl-processor:v1.0.0

# Update image tags in deployments
sed -i 's/:latest/:v1.0.0/g' infrastructure/kubernetes/deployments/*.yaml
```

#### 3.2 Deploy Applications

```bash
# Deploy ConfigMaps
kubectl apply -f infrastructure/kubernetes/configmaps/

# Deploy applications
kubectl apply -f infrastructure/kubernetes/deployments/

# Deploy HPA
kubectl apply -f infrastructure/kubernetes/hpa/

# Deploy Ingress
kubectl apply -f infrastructure/kubernetes/ingress/
```

#### 3.3 Verify Deployment

```bash
# Check pods
kubectl get pods -n happycmdb-cmdb

# Check deployments
kubectl get deployments -n happycmdb-cmdb

# Check HPA
kubectl get hpa -n happycmdb-cmdb

# Test health endpoint
kubectl port-forward svc/api-server 3000:3000 -n happycmdb-cmdb
curl http://localhost:3000/api/v1/health | jq
```

### Phase 4: Networking and Security (Day 2-3)

#### 4.1 Configure DNS

```bash
# Get LoadBalancer external IP
kubectl get ingress -n happycmdb-cmdb

# Create DNS A record
# api.happycmdb.yourdomain.com -> EXTERNAL-IP
```

#### 4.2 Configure TLS Certificates

```bash
# Create ClusterIssuer for Let's Encrypt
kubectl apply -f - <<EOF
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: admin@yourdomain.com
    privateKeySecretRef:
      name: letsencrypt-prod
    solvers:
    - http01:
        ingress:
          class: nginx
EOF

# Certificates will be automatically provisioned via Ingress annotations
```

#### 4.3 Configure Network Policies

```bash
# Apply network policies (create this file)
kubectl apply -f infrastructure/kubernetes/network-policies/
```

### Phase 5: Monitoring and Alerting (Day 3-4)

#### 5.1 Deploy Monitoring Stack

```bash
# Install Prometheus Operator
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm install prometheus prometheus-community/kube-prometheus-stack \
  --namespace monitoring \
  --create-namespace

# Install Loki for logs
helm repo add grafana https://grafana.github.io/helm-charts
helm install loki grafana/loki-stack \
  --namespace monitoring
```

#### 5.2 Configure Dashboards

```bash
# Import HappyCMDB dashboards to Grafana
kubectl port-forward svc/prometheus-grafana 3000:80 -n monitoring

# Access Grafana at http://localhost:3000
# Default credentials: admin/prom-operator
```

### Phase 6: Testing and Validation (Day 4-5)

#### 6.1 Functional Testing

```bash
# Test API endpoints
curl https://api.happycmdb.yourdomain.com/api/v1/health

# Test discovery
curl -X POST https://api.happycmdb.yourdomain.com/api/v1/discovery/aws \
  -H "Content-Type: application/json" \
  -d '{"region": "us-east-1"}'

# Test CI creation
curl -X POST https://api.happycmdb.yourdomain.com/api/v1/cis \
  -H "Content-Type: application/json" \
  -d '{
    "name": "test-server",
    "ci_type": "server",
    "environment": "test"
  }'
```

#### 6.2 Performance Testing

```bash
# Install k6 for load testing
brew install k6  # macOS
# or download from https://k6.io/

# Run load test
k6 run - <<EOF
import http from 'k6/http';
import { check } from 'k6';

export let options = {
  stages: [
    { duration: '2m', target: 100 },
    { duration: '5m', target: 100 },
    { duration: '2m', target: 0 },
  ],
};

export default function () {
  let res = http.get('https://api.happycmdb.yourdomain.com/api/v1/health');
  check(res, { 'status was 200': (r) => r.status == 200 });
}
EOF
```

#### 6.3 Disaster Recovery Testing

```bash
# Test Neo4j failover
kubectl delete pod neo4j-0 -n happycmdb-cmdb
kubectl get pods -n happycmdb-cmdb -w

# Test API server scaling
kubectl scale deployment api-server --replicas=0 -n happycmdb-cmdb
kubectl scale deployment api-server --replicas=3 -n happycmdb-cmdb

# Test backup restore (use test environment)
```

## Post-Deployment Tasks

### Day 1 After Launch

- [ ] Monitor error rates and latency
- [ ] Verify automated backups are running
- [ ] Test alerting configuration
- [ ] Review resource utilization
- [ ] Document any issues encountered

### Week 1 After Launch

- [ ] Performance tuning based on actual load
- [ ] Review and adjust HPA settings
- [ ] Optimize database queries
- [ ] Update documentation with production IPs/URLs
- [ ] Conduct security review

### Month 1 After Launch

- [ ] Review backup retention policies
- [ ] Analyze cost optimization opportunities
- [ ] Plan capacity for growth
- [ ] Review and update monitoring dashboards
- [ ] Conduct disaster recovery drill

## Rollback Procedures

### Application Rollback

```bash
# Rollback to previous deployment
kubectl rollout undo deployment/api-server -n happycmdb-cmdb

# Rollback to specific revision
kubectl rollout history deployment/api-server -n happycmdb-cmdb
kubectl rollout undo deployment/api-server --to-revision=2 -n happycmdb-cmdb
```

### Database Rollback

```bash
# Restore from backup (PostgreSQL example)
kubectl exec -it postgres-0 -n happycmdb-cmdb -- bash
pg_restore -U cmdb_user -d cmdb /backups/backup-TIMESTAMP.dump

# Restore Neo4j from backup
kubectl exec -it neo4j-0 -n happycmdb-cmdb -- bash
neo4j-admin restore --from=/backups/backup-TIMESTAMP --database=neo4j
```

### Infrastructure Rollback (Terraform)

```bash
cd infrastructure/terraform

# View state history
terraform state list

# Rollback to previous state
terraform plan -out=rollback.tfplan
terraform apply rollback.tfplan
```

## Maintenance Procedures

### Regular Maintenance Windows

**Recommended Schedule:**
- **Weekly**: Security patches (non-disruptive)
- **Monthly**: Minor version updates
- **Quarterly**: Major version updates and DR testing

### Update Procedure

```bash
# 1. Backup everything
kubectl exec postgres-0 -n happycmdb-cmdb -- pg_dumpall > backup-before-update.sql

# 2. Update one service at a time
kubectl set image deployment/api-server api-server=happycmdb/api-server:v1.1.0 -n happycmdb-cmdb

# 3. Monitor rollout
kubectl rollout status deployment/api-server -n happycmdb-cmdb

# 4. Verify health
curl https://api.happycmdb.yourdomain.com/api/v1/health

# 5. Proceed with next service
```

## Troubleshooting Production Issues

### Issue: High API Latency

```bash
# Check API pod logs
kubectl logs -f deployment/api-server -n happycmdb-cmdb --tail=100

# Check database performance
kubectl exec postgres-0 -n happycmdb-cmdb -- psql -U cmdb_user -c "
SELECT query, calls, mean_exec_time
FROM pg_stat_statements
ORDER BY mean_exec_time DESC
LIMIT 10;"

# Check Neo4j query performance
kubectl exec neo4j-0 -n happycmdb-cmdb -- cypher-shell -u neo4j -p PASSWORD "
CALL dbms.listQueries() YIELD query, elapsedTimeMillis
WHERE elapsedTimeMillis > 1000
RETURN query, elapsedTimeMillis
ORDER BY elapsedTimeMillis DESC;"
```

### Issue: Pod CrashLoopBackOff

```bash
# Get pod details
kubectl describe pod <pod-name> -n happycmdb-cmdb

# Check logs
kubectl logs <pod-name> -n happycmdb-cmdb --previous

# Check events
kubectl get events -n happycmdb-cmdb --sort-by='.lastTimestamp'
```

### Issue: Out of Disk Space

```bash
# Check PVC usage
kubectl exec <pod-name> -n happycmdb-cmdb -- df -h

# Resize PVC (if storage class allows)
kubectl patch pvc <pvc-name> -n happycmdb-cmdb -p '{"spec":{"resources":{"requests":{"storage":"200Gi"}}}}'

# Clean up old data
kubectl exec postgres-0 -n happycmdb-cmdb -- vacuumdb -U cmdb_user -d cmdb --full
```

## Contact and Support

- **Documentation**: https://docs.happycmdb.io
- **Community Forum**: https://community.happycmdb.io
- **GitHub Issues**: https://github.com/your-org/happycmdb/issues
- **Slack**: https://happycmdb.slack.com
- **Email**: support@happycmdb.io
- **Emergency Hotline**: +1-XXX-XXX-XXXX (24/7 for enterprise customers)
