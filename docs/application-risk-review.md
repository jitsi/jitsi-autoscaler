# Application Design Risk Review: jitsi-autoscaler

_Reviewed: 2026-03-25_

Comprehensive risk review examining high availability, cloud cost, degraded provider handling, concurrency, security, and operational risks.

---

## Risk Priority Matrix

| # | Risk | Severity | Likelihood | Category |
|---|------|----------|------------|----------|
| 1 | Redis SPOF - total system failure | Critical | Medium | HA |
| 2 | ~~No graceful shutdown - orphaned locks~~ | ~~Critical~~ | ~~High~~ | ~~HA~~ | MITIGATED |
| 3 | No max bounds on maxDesired/scaleUpQuantity | Critical | Medium | Cost |
| 4 | DO pagination - 100 instance cap | Critical | Low-Med | Cost |
| 5 | Non-atomic desired count updates | High | Medium | Concurrency |
| 6 | Lock expiration during slow jobs | High | Medium | Concurrency |
| 7 | Scale-down depends on sidecar cooperation | High | Medium | Cost |
| 8 | No circuit breaker for cloud APIs | High | Medium | Degraded Provider |
| 9 | Prometheus failure = zero metrics = scale down | High | Medium | Cost |
| 10 | Failed jobs auto-removed, zero retries | High | High | Operational |
| 11 | Sidecar endpoints unprotected when flag off | High | Low | Security |
| 12 | ~~Health check doesn't cover job queue~~ | ~~Medium~~ | ~~High~~ | ~~HA~~ | MITIGATED |
| 13 | Partial cloud results treated as complete | Medium | Medium | Degraded Provider |
| 14 | TOCTOU in group deletion | Medium | Low | Concurrency |
| 15 | Consul store incomplete implementation | Medium | Low | Operational |

---

## 1. HIGH AVAILABILITY RISKS

### 1.1 Single Redis = Single Point of Failure
- **All** state (instance tracking, metrics, locks, job queues) depends on one Redis connection (`src/app.ts:87-96`)
- No circuit breaker, no fallback store, no read replica
- If Redis dies: no jobs created, no locks acquired, no scaling decisions made
- Redis retry strategy has no upper bound on total retry time (`maxRetriesPerRequest: null`)

### 1.2 ~~No Graceful Shutdown~~ [MITIGATED]
SIGTERM/SIGINT handlers added in `src/app.ts`. Shutdown sequence: stops job scheduling timers, closes HTTP servers (returns 503), drains Bee-Queue (30s timeout), shuts down lock manager (Redlock quit / Consul session destroy), disconnects Redis. 45-second hard kill safety net prevents hangs.

### 1.3 ~~Health Check is Incomplete~~ [MITIGATED]
Deep health check (`GET /health?deep`) now verifies both instance store and job queue (Bee-Queue `checkHealth()`). Returns structured JSON on failure indicating which subsystem is unhealthy. Returns 503 during graceful shutdown to drain load balancer traffic.

### 1.4 Startup Without Verification
- `startProcessingGroups()` (`src/app.ts:337-338`) called async without awaiting success
- If initial job creation fails, app still serves traffic but never autoscales

### 1.5 Redlock with Single Redis Client
- `src/lock_manager.ts:149`: TODO comment acknowledges single client defeats Redlock's distributed guarantee
- Lock safety depends entirely on one Redis instance

---

## 2. CLOUD COST RISKS

### 2.1 No System-Level Cost Guardrails
- `maxDesired` validated only as `isInt({ min: 0 })` (`src/app.ts:485-492`) - no upper bound
- Operator typo (e.g., `maxDesired=10000`) triggers scaling to that ceiling
- No rate-of-change limit: `scaleUpQuantity` also unbounded
- No global instance count limit across all groups

### 2.2 Orphaned Instances from Partial Launch Failures
- `src/instance_launcher.ts:200-238`: If cloud launches 5/10 requested, only 5 tracked
- But error thrown causes retry next cycle, launching 5 more (total 15 instead of 10)
- Custom script timeout (`src/custom_instance_manager.ts:103-122`) kills script but not the launched VM

### 2.3 Scale-Down Relies on Sidecar Cooperation
- `cloudManager.scaleDown()` (`src/cloud_manager.ts:116-122`) only sets a shutdown flag in Redis
- Actual termination requires sidecar to poll, receive command, and acknowledge
- If sidecar is dead/unreachable: instance runs indefinitely, removed from tracking after TTL, still incurs cloud cost

### 2.4 DigitalOcean Pagination Bug
- `src/digital_ocean_instance_manager.ts:103-120`: Hardcoded `per_page: 100`, no pagination handling
- Groups with >100 instances only show first 100
- Autoscaler thinks fewer instances exist, scales up more

### 2.5 Stale Metrics Drive Wrong Decisions
- Prometheus query failures return empty array (`src/prometheus.ts:143-161`), interpreted as zero load
- Zero load triggers scale-down, potentially terminating healthy instances under load
- Cloud instance cache (`src/metrics_loop.ts:203-212`) has no staleness check

---

## 3. DEGRADED CLOUD PROVIDER RISKS

### 3.1 No Circuit Breaker for Cloud APIs
- Cloud API calls retry for up to `maxTimeInSeconds` (e.g., 30s for Oracle) then fail
- No circuit breaker pattern: every group's job independently retries against degraded API
- Multiple concurrent timeouts exhaust job processing capacity

### 3.2 Partial Cloud API Results Treated as Complete
- `src/sanity_loop.ts:36-66`: Saves whatever cloud API returns without completeness check
- Partial results cause autoscaler to undercount instances, triggering unnecessary scale-up
- Cloud guard bypass: `src/autoscaler.ts:101-142` uses cached cloud instances first (potentially 60s stale), falls back to live query only if cache empty

### 3.3 No Rate Limiting Awareness
- `CloudRetryStrategy` includes 429 in retryable codes but uses fixed delay, not exponential backoff
- Multiple groups hitting same provider can cause cascading throttling

### 3.4 Oracle SDK Timeout Cascades
- `src/oracle_instance_manager.ts:261-318`: 30s timeout per request
- 3 concurrent groups x 30s = 90s, exceeding job timeout (60-120s)
- Jobs fail, requeue, retry same failing API

---

## 4. CONCURRENCY RISKS

### 4.1 Non-Atomic Desired Count Updates
- `src/autoscaler.ts:262-268`: Reads group, modifies in-memory, writes back
- No compare-and-swap or version check
- Two concurrent autoscaler instances can overwrite each other's scaling decisions

### 4.2 Lock Expiration During Slow Processing
- If job takes longer than lock TTL, lock expires mid-processing
- Another instance acquires same lock, both process same group concurrently
- No heartbeat/watchdog to detect lost lock

### 4.3 Job Creation Race Conditions
- `src/job_manager.ts:363-391`: Jobs created via `Promise.all()` without atomicity
- Partial failure leaves some jobs created, some not
- Retry creates duplicates for already-created jobs

### 4.4 TOCTOU in Group Deletion
- `src/app.ts:688-693`: Validates "no active instances" in express-validator chain BEFORE lock acquired
- Instance can launch between validation and deletion
- Autoscale job started before deletion continues with stale group data, potentially recreating deleted group

### 4.5 Instance State Save Not Awaited
- `src/instance_tracker.ts:172`: `saveInstanceStatus()` called without `await` (fire-and-forget)
- State save failure means metrics and instance state diverge

### 4.6 Race Between Launcher Decision and Execution
- `src/instance_launcher.ts:87-265`: Desired count read at line 99, launch at line 201
- No lock held during this gap; desiredCount can change mid-launch

---

## 5. SECURITY / AUTH RISKS

### 5.1 Sidecar Endpoints Unprotected When PROTECTED_API=false
- `/sidecar/poll`, `/sidecar/stats`, `/sidecar/status`, `/sidecar/shutdown` bypass JWT when flag is off
- Attacker can report fake metrics, trigger shutdown, impersonate any instance
- Demo `docker-compose.yml` sets `PROTECTED_API=false`

### 5.2 No Instance Ownership Validation
- Sidecar endpoints don't verify that caller actually owns the claimed instance/group
- Any authenticated sidecar can report metrics for any group

### 5.3 ASAP Key Fetch Has No Timeout
- `src/asap.ts:33`: Public key fetched via HTTP with no timeout
- If key server hangs, auth middleware hangs, blocking all requests

---

## 6. OPERATIONAL / OBSERVABILITY RISKS

### 6.1 Failed Jobs Auto-Removed
- `src/job_manager.ts:131-133`: `removeOnFailure: true` - no post-mortem possible
- Zero retries (`src/job_manager.ts:382`): one transient failure = lost scaling cycle

### 6.2 Error Swallowing Throughout
- Cloud guard failures: logged as warning, processing continues without safety check (`src/autoscaler.ts:136-141`, `src/instance_launcher.ts:157-198`)
- Redis pipeline failures: return empty array instead of throwing (`src/redis.ts:257-265`)
- Metrics loop failures: logged and returned (`src/metrics_loop.ts:86-127`)

### 6.3 Consul Store Incomplete
- `src/consul.ts:271-278`: `filterOutAndTrimExpiredStates()` is a no-op - expired states never cleaned up
- `src/lock_manager.ts:71-96`: Consul session renewal has no failure recovery

### 6.4 TODO Comments in Critical Paths
- `src/instance_tracker.ts:100`: `// TODO: increment stats report error counter` - errors not counted
- `src/group_report.ts:167`: `// @TODO: implement JVB instance counting` - incomplete reporting
- `src/lock_manager.ts:149`: Single Redis client acknowledged as wrong
