# Kubernetes Deployment

Deploy HappyCMDB on Kubernetes for production-grade scalability and high availability.

## Prerequisites

- Kubernetes cluster 1.25 or higher
- `kubectl` configured to access your cluster
- Helm 3.x installed (for Helm chart deployment)
- At least 3 worker nodes with 4GB RAM each
- Storage class configured for persistent volumes

## Deployment Methods

### Method 1: Helm Chart (Recommended)

#### Install HappyCMDB using Helm

```bash
# Add the HappyCMDB Helm repository
helm repo add happycmdb https://charts.happycmdb.io
helm repo update

# Install with default values
helm install happycmdb happycmdb/happycmdb \\
  --namespace happycmdb \\
  --create-namespace

# Or install with custom values
helm install happycmdb happycmdb/happycmdb \\
  --namespace happycmdb \\
  --create-namespace \\
  --values custom-values.yaml
```

#### Custom Values Example

Create `custom-values.yaml`:

```yaml
# HappyCMDB Helm Values (v3.0)

# Global settings
global:
  storageClass: "gp3"  # AWS EBS gp3
  domain: "cmdb.example.com"

# API Server (v3.0 - increased for ITIL/TBM/BSM)
api:
  replicaCount: 3
  resources:
    requests:
      memory: "2Gi"
      cpu: "1000m"
    limits:
      memory: "4Gi"
      cpu: "4000m"
  autoscaling:
    enabled: true
    minReplicas: 3
    maxReplicas: 10
    targetCPUUtilizationPercentage: 70
  env:
    # v3.0 Features
    ENABLE_ITIL: "true"
    ENABLE_TBM: "true"
    ENABLE_BSM: "true"
    ENABLE_AI_DISCOVERY: "true"

# Discovery Engine (v3.0 - increased for AI discovery)
discovery:
  replicaCount: 2
  resources:
    requests:
      memory: "4Gi"
      cpu: "2000m"
    limits:
      memory: "8Gi"
      cpu: "4000m"
  env:
    # v3.0 Enrichment
    ENABLE_ITIL_ENRICHMENT: "true"
    ENABLE_TBM_ENRICHMENT: "true"
    ENABLE_BSM_ENRICHMENT: "true"
    ENABLE_AI_DISCOVERY: "true"

# Neo4j Database
neo4j:
  enabled: true
  persistence:
    size: 50Gi
  resources:
    requests:
      memory: "4Gi"
      cpu: "2000m"
    limits:
      memory: "8Gi"
      cpu: "4000m"

# PostgreSQL Database
postgresql:
  enabled: true
  persistence:
    size: 100Gi
  resources:
    requests:
      memory: "2Gi"
      cpu: "1000m"
    limits:
      memory: "4Gi"
      cpu: "2000m"

# Redis
redis:
  enabled: true
  persistence:
    size: 10Gi
  resources:
    requests:
      memory: "512Mi"
      cpu: "500m"
    limits:
      memory: "2Gi"
      cpu: "1000m"

# Kafka (v3.0 - Event Streaming)
kafka:
  enabled: true
  replicas: 3
  persistence:
    size: 100Gi
  resources:
    requests:
      memory: "1Gi"
      cpu: "1000m"
    limits:
      memory: "2Gi"
      cpu: "2000m"

# Metabase (v3.0 - Business Intelligence)
metabase:
  enabled: true
  resources:
    requests:
      memory: "2Gi"
      cpu: "500m"
    limits:
      memory: "4Gi"
      cpu: "2000m"

# Ingress
ingress:
  enabled: true
  className: "nginx"
  annotations:
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
  hosts:
    - host: cmdb.example.com
      paths:
        - path: /
          pathType: Prefix
  tls:
    - secretName: happycmdb-tls
      hosts:
        - cmdb.example.com

# Monitoring
monitoring:
  enabled: true
  prometheus:
    enabled: true
  grafana:
    enabled: true
```

### Method 2: Kubectl with Manifests

#### 1. Create Namespace

```bash
kubectl create namespace happycmdb
```

#### 2. Create Secrets

```bash
# Database credentials
kubectl create secret generic db-credentials \\
  --namespace happycmdb \\
  --from-literal=neo4j-password='your-neo4j-password' \\
  --from-literal=postgres-password='your-postgres-password' \\
  --from-literal=redis-password='your-redis-password'

# Application secrets
kubectl create secret generic app-secrets \\
  --namespace happycmdb \\
  --from-literal=jwt-secret='your-jwt-secret' \\
  --from-literal=api-key='your-api-key'

# Cloud provider credentials (if using discovery)
kubectl create secret generic cloud-credentials \\
  --namespace happycmdb \\
  --from-literal=aws-access-key-id='your-aws-key' \\
  --from-literal=aws-secret-access-key='your-aws-secret' \\
  --from-literal=azure-client-id='your-azure-client' \\
  --from-literal=azure-client-secret='your-azure-secret'
```

#### 3. Apply Manifests

```bash
# Apply all manifests
kubectl apply -f k8s/

# Or apply individually
kubectl apply -f k8s/neo4j/
kubectl apply -f k8s/postgresql/
kubectl apply -f k8s/redis/
kubectl apply -f k8s/api-server/
kubectl apply -f k8s/discovery-engine/
kubectl apply -f k8s/etl-processor/
kubectl apply -f k8s/web-ui/
kubectl apply -f k8s/ingress/
```

## Verification

### Check Pod Status

```bash
kubectl get pods -n happycmdb
```

Expected output (v3.0):
```
NAME                                READY   STATUS    RESTARTS   AGE
happycmdb-api-xxx                 1/1     Running   0          5m
happycmdb-discovery-xxx           1/1     Running   0          5m
happycmdb-etl-xxx                 1/1     Running   0          5m
happycmdb-neo4j-0                 1/1     Running   0          5m
happycmdb-postgresql-0            1/1     Running   0          5m
happycmdb-redis-0                 1/1     Running   0          5m
happycmdb-kafka-0                 1/1     Running   0          5m
happycmdb-kafka-1                 1/1     Running   0          5m
happycmdb-kafka-2                 1/1     Running   0          5m
happycmdb-metabase-xxx            1/1     Running   0          5m
happycmdb-web-ui-xxx              1/1     Running   0          5m
```

### Check Services

```bash
kubectl get svc -n happycmdb
```

### Check Ingress

```bash
kubectl get ingress -n happycmdb
```

### View Logs

```bash
# API Server logs
kubectl logs -n happycmdb -l app=happycmdb-api -f

# Discovery Engine logs
kubectl logs -n happycmdb -l app=happycmdb-discovery -f
```

## Scaling

### Manual Scaling

```bash
# Scale API servers
kubectl scale deployment happycmdb-api \\
  --namespace happycmdb \\
  --replicas=5

# Scale discovery workers
kubectl scale deployment happycmdb-discovery \\
  --namespace happycmdb \\
  --replicas=3
```

### Horizontal Pod Autoscaling

```bash
# Enable autoscaling for API servers
kubectl autoscale deployment happycmdb-api \\
  --namespace happycmdb \\
  --min=3 \\
  --max=10 \\
  --cpu-percent=70
```

## Monitoring

### Install Prometheus Stack

```bash
# Add Prometheus Helm repo
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update

# Install Prometheus + Grafana
helm install prometheus prometheus-community/kube-prometheus-stack \\
  --namespace monitoring \\
  --create-namespace
```

### Access Grafana

```bash
# Port forward Grafana
kubectl port-forward -n monitoring svc/prometheus-grafana 3000:80
```

Open `http://localhost:3000` (default credentials: admin/prom-operator)

## Backup Strategy

### Neo4j Backups

```bash
# Create a CronJob for automated backups
kubectl apply -f k8s/backup/neo4j-backup-cronjob.yaml
```

### PostgreSQL Backups

```bash
# Create a CronJob for automated backups
kubectl apply -f k8s/backup/postgres-backup-cronjob.yaml
```

## Troubleshooting

### Pods Not Starting

```bash
# Describe pod to see events
kubectl describe pod <pod-name> -n happycmdb

# Check logs
kubectl logs <pod-name> -n happycmdb
```

### Database Connection Issues

```bash
# Test Neo4j connection
kubectl run -it --rm debug \\
  --image=neo4j:5 \\
  --namespace happycmdb \\
  --restart=Never \\
  -- cypher-shell -u neo4j -p password -a bolt://happycmdb-neo4j:7687

# Test PostgreSQL connection
kubectl run -it --rm debug \\
  --image=postgres:15 \\
  --namespace happycmdb \\
  --restart=Never \\
  -- psql -h happycmdb-postgresql -U postgres
```

## Production Checklist

- [ ] Enable TLS/SSL for all services
- [ ] Configure persistent volumes with appropriate storage class
- [ ] Set up automated backups
- [ ] Configure resource limits and requests
- [ ] Enable horizontal pod autoscaling
- [ ] Set up monitoring and alerting
- [ ] Configure ingress with valid certificates
- [ ] Implement network policies
- [ ] Set up log aggregation
- [ ] Document disaster recovery procedures

## Next Steps

- [Health Checks](./health-checks)
- [Monitoring Setup](/monitoring/overview)
- [Backup Procedures](/operations/backup/procedures)
- [Scaling Guide](/operations/scaling/overview)
