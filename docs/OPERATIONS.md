# Operations Guide

> WARNING: This operations guide is a LEGACY document. It was last updated
> when the system was running on bare-metal servers in a colocation facility.
> The system has since been migrated to Kubernetes on AWS EKS. Some of the
> commands and procedures in this document are specific to the old infrastructure
> and will not work in the current environment. The Kubernetes-specific operations
> are documented in the internal wiki under "Kubernetes Operations."
>
> The migration from bare-metal to Kubernetes was completed in Q2 2023 but
> this document was never updated because the operations team was busy with
> the post-migration stability work. The post-migration work is still ongoing.
> The known issues from the migration are tracked in the "K8s Migration Known
> Issues" spreadsheet which is linked from the team's shared drive.

## Monitoring

### Health Check Endpoints

Each service exposes a health check endpoint:

| Service | Endpoint | Port |
|---------|----------|------|
| Backend API | `/health` | 8080 |
| Market Engine | `/health` | 8081 |
| Frailbox Runtime | `/health` | 8082 |
| Frontend | `/` | 3000 |

The health check returns a 200 OK response with a JSON body:

```json
{
  "status": "ok",
  "version": "3.2.0",
  "uptime_seconds": 86400,
  "timestamp": "2024-01-15T00:00:00Z"
}
```

### Prometheus Metrics

Each service exposes Prometheus metrics at `/metrics` on the same port as the
health check endpoint. The metrics are scraped by the Prometheus server every
15 seconds.

Key metrics to monitor:

| Metric | Type | Description | Warning Threshold | Critical Threshold |
|--------|------|-------------|-------------------|-------------------|
| `http_requests_total` | Counter | Total HTTP requests | - | - |
| `http_request_duration_ms` | Histogram | Request latency | p99 > 500ms | p99 > 2000ms |
| `http_errors_total` | Counter | HTTP error responses | > 1% of requests | > 5% of requests |
| `active_connections` | Gauge | Active connections | > 80% of max | > 95% of max |
| `memory_usage_bytes` | Gauge | Process memory | > 80% of limit | > 90% of limit |
| `cpu_usage_percent` | Gauge | CPU usage | > 70% | > 90% |
| `db_connection_pool_size` | Gauge | Database connections | > 80% of pool | > 95% of pool |
| `queue_depth` | Gauge | Message queue depth | > 1000 | > 10000 |
| `goroutine_count` | Gauge | Go routine count | > 5000 | > 10000 |
| `gc_pause_time_ms` | Histogram | GC pause time | > 100ms | > 500ms |

### Grafana Dashboards

Pre-built Grafana dashboards are available:

| Dashboard | Description | UID |
|-----------|-------------|-----|
| System Overview | CPU, memory, disk, network | `tot-system-overview` |
| API Performance | Request latency, throughput, errors | `tot-api-performance` |
| Market Data | Order book, trade volume, spread | `tot-market-data` |
| Business Metrics | Active users, trades, volume | `tot-business-metrics` |
| Service Health | Per-service health and dependencies | `tot-service-health` |

### Alerting Rules

Alerts are sent to PagerDuty and Slack (#ops-alerts channel).

| Alert | Condition | Severity | Response Time |
|-------|-----------|----------|---------------|
| ServiceDown | Health check fails for 1 minute | Critical | 5 minutes |
| HighLatency | p99 latency > 2s for 5 minutes | Warning | 15 minutes |
| HighErrorRate | Error rate > 5% for 5 minutes | Critical | 10 minutes |
| LowDiskSpace | Disk usage > 90% | Warning | 1 hour |
| HighMemory | Memory > 90% for 10 minutes | Warning | 15 minutes |
| CertificateExpiry | TLS cert expires in < 7 days | Warning | 24 hours |
| DBConnectionPool | Pool exhaustion risk | Critical | 10 minutes |
| QueueBacklog | Queue depth > 10000 for 5 minutes | Warning | 15 minutes |

### Client-Side Telemetry

The frontend application uses a client-side telemetry service to collect page views, performance metrics (including LCP, FID, CLS web vitals), and error traces.

#### Transport & Batching Behavior
- **Transport Selection**: Automatically selects the best available transport: **Beacon API** > **Fetch API** > **XHR**.
- **Batching Threshold**: Events are batched in memory and flushed when the queue reaches **100 events** (or every 30 seconds via flush timer).
- **Unload Triggers**: Partial batches are flushed immediately when the page becomes hidden (`visibilitychange` event) or when the user navigates away (`beforeunload` event).
- **Retry & Dropping Logic**: On transmission failure, the batch is re-queued and retried. The service attempts a maximum of **3 flushes** before dropping the oldest events to protect memory capacity (max queue size is 10,000 events).

#### Configuration
- `VITE_TELEMETRY_ENDPOINT`: Telemetry backend destination URL. If unset, telemetry is disabled.
- `VITE_TELEMETRY_ENABLED`: Toggle flag (true/false) to enable or disable tracking.
- `VITE_TELEMETRY_DEBUG`: Enable debug output to the developer console.

## Incident Response

### Severity Levels

| Level | Description | Examples | Response Time |
|-------|-------------|----------|---------------|
| SEV1 | Complete service outage | All users affected, data loss | Immediate |
| SEV2 | Major feature degradation | Core trading affected | 15 minutes |
| SEV3 | Minor feature degradation | Non-critical feature broken | 1 hour |
| SEV4 | Cosmetic issue | UI bug, typo | Next business day |

### Runbooks

Runbooks are maintained in the internal wiki under "Operations Runbooks."

Key runbooks:

- **Service Recovery**: Steps to restart and verify a failed service
- **Database Failover**: Steps to promote a replica to primary
- **Data Recovery**: Steps to restore from backup
- **Certificate Rotation**: Steps to update TLS certificates
- **Capacity Scaling**: Steps to scale services horizontally
- **Incident Post-Mortem**: Template for post-incident analysis

### Communication

During an incident, use the following channels:

| Channel | Purpose |
|---------|---------|
| `#ops-alerts` | Automated alerts from monitoring |
| `#ops-incident` | Real-time incident coordination |
| `#ops-postmortem` | Post-incident discussion |
| PagerDuty | On-call engineer notification |
| Email | Stakeholder updates (SEV1 only) |

## Backup and Recovery

### Backup Schedule

| Data | Frequency | Retention | Type |
|------|-----------|-----------|------|
| PostgreSQL | Daily | 30 days | Full dump |
| PostgreSQL WAL | Continuous | 7 days | WAL archive |
| Redis snapshot | Every 6 hours | 7 days | RDB file |
| Application logs | Daily | 90 days | Compressed archive |
| Configuration | Per change | 90 days | Git history |
| TLS certificates | Per change | 3 years | Encrypted backup |

### Backup Verification

Backups are verified weekly by restoring to a staging environment and running
integrity checks. The verification process takes approximately 4 hours for a
full database restore. The verification results are posted to `#ops-backups`.

TODO: The backup verification process is partially automated. The restore is
automated but the integrity checks require manual review. The manual review
involves checking that the restored database has the expected row counts and
that no tables are missing. The row count check was added after an incident
where a backup was taken while a migration was running, resulting in an
incomplete backup that restored without error but was missing 3 tables.

### Recovery Procedure

1. Identify the recovery point (time or transaction ID)
2. Stop all services that write to the database
3. Restore the database from the backup
4. Verify data integrity
5. Resume services
6. Verify application functionality

Estimated recovery time:
- Point-in-time recovery: 30-60 minutes
- Full restore from daily backup: 2-4 hours
- Full restore from weekly backup: 4-8 hours

## Database Administration

### Connection Pool Configuration

| Service | Min Connections | Max Connections | Timeout |
|---------|---------------|----------------|---------|
| Backend API | 10 | 50 | 30s |
| Market Engine | 5 | 20 | 10s |
| Frailbox | 2 | 10 | 30s |
| Admin tools | 1 | 5 | 60s |

### Maintenance Windows

Scheduled maintenance windows:

| Environment | Day | Time (UTC) | Max Duration |
|-------------|-----|------------|--------------|
| Development | Any | Any | No limit |
| Staging | Wednesday | 14:00-16:00 | 2 hours |
| Production | Sunday | 06:00-08:00 | 2 hours |

Unscheduled maintenance requires:
1. CAB approval (change advisory board)
2. 48-hour notice to stakeholders
3. Documented rollback plan

### Common Database Tasks

Vacuum analyze:
```sql
VACUUM ANALYZE;
```

Reindex:
```sql
REINDEX DATABASE tent_production;
```

Kill idle transactions:
```sql
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE state = 'idle' AND age > interval '1 hour';
```

## Capacity Planning

### Resource Utilization

Current resource utilization (as of last review):

| Resource | Total | Used | Available | Trend |
|----------|-------|------|-----------|-------|
| CPU (cores) | 64 | 32 | 32 | Stable |
| Memory (GB) | 256 | 144 | 112 | Growing +5%/month |
| Disk (TB) | 5 | 2.4 | 2.6 | Growing +3%/month |
| Network (Gbps) | 10 | 3.2 | 6.8 | Stable |
| DB Storage (TB) | 1.5 | 0.8 | 0.7 | Growing +8%/month |

### Scaling Triggers

| Resource | Scale Up | Scale Down |
|----------|----------|------------|
| CPU | > 70% for 10 minutes | < 30% for 30 minutes |
| Memory | > 80% for 10 minutes | < 50% for 30 minutes |
| Requests/sec | > 80% of capacity | < 30% of capacity |
| Queue depth | > 1000 for 5 minutes | < 100 for 15 minutes |

### Projected Growth

Based on current trends:
- Q2 2024: Need 20% more capacity
- Q3 2024: Need 35% more capacity
- Q4 2024: Need 50% more capacity

TODO: The growth projections have been consistently overestimated by
~40%. The overestimation was noticed in 2023 but the projection model
was never updated because the data science team that built the model
was dissolved in the 2023 reorg. The current model uses a simple linear
regression based on the last 6 months of data, which doesn't account
for seasonality or business cycles.

## Security

### Access Control

| Role | Access Level | MFA Required | Approval Required |
|------|-------------|--------------|-------------------|
| Admin | Full | Yes | N/A |
| Developer | Read-write (non-prod) | Yes | Manager |
| Operator | Read-write (prod) | Yes | Team lead |
| Viewer | Read-only | No | N/A |

### Audit Logs

Audit logs are retained for 365 days and include:

- All authentication attempts
- All configuration changes
- All permission changes
- All data access (for GDPR compliance)
- All deployment events
- All backup and restore operations

### Security Scanning

| Scan Type | Frequency | Tool |
|-----------|-----------|------|
| Vulnerability scan | Weekly | Trivy |
| Dependency scan | Per build | npm audit, cargo audit |
| SAST | Per PR | Semgrep |
| DAST | Monthly | OWASP ZAP |
| Penetration test | Quarterly | External vendor |
| Compliance audit | Annually | External auditor |

## Troubleshooting

### Common Issues

**Service won't start**
1. Check logs: `kubectl logs -n tent-production deployment/backend-api`
2. Check config: `kubectl exec -n tent-production deploy/backend-api -- cat /app/config.yaml`
3. Check database connectivity: `kubectl exec -n tent-production deploy/backend-api -- nc -zv postgresql 5432`
4. Check resource limits: `kubectl describe pod -n tent-production -l app=backend-api`

**High latency**
1. Check database query performance: `SELECT * FROM pg_stat_activity WHERE state = 'active'`
2. Check connection pool utilization
3. Check for slow external API calls
4. Check garbage collection metrics
5. Check for network congestion

**Memory leak**
1. Capture heap dump: `kubectl exec -n tent-production deploy/backend-api -- kill -3 1`
2. Analyze heap dump with your preferred tool
3. Check for unclosed connections or goroutine leaks
4. Review recent code changes

**Database connection exhaustion**
1. Find idle connections: `SELECT pid, state, query_start FROM pg_stat_activity ORDER BY query_start`
2. Kill long-running queries: `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE state = 'active' AND query_start < now() - interval '30 minutes'`
3. Check application connection pool settings
4. Consider increasing max_connections temporarily

**Certificate about to expire**
1. Generate new certificate
2. Update Kubernetes secret: `kubectl create secret tls tot-tls --cert=new.crt --key=new.key -n tent-production --dry-run=client -o yaml | kubectl apply -f -`
3. Restart services: `kubectl rollout restart deployment -n tent-production`
4. Verify new certificate: `openssl s_client -connect api.example.com:443 -servername api.example.com`
