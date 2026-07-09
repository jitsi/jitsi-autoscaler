# Codebase Review: Operational Risks & Recommendations

**Date:** 2026-07-09
**Branch:** `JIT-16014-storage-lock-remediation` (commit `e61db8e`)
**Scope:** Full codebase (~18.5k lines of TypeScript) — core scaling loop, storage & locking, REST API/app wiring, cloud provider layer, scheduled scaling & reservations, MCP server, and cross-cutting build/deploy.
**Method:** Six parallel subsystem reviews with end-to-end code-path verification; top findings independently confirmed by multiple reviewers and re-verified manually.

---

## Critical

### 1. `availability` groups autoscale on a permanently-zero metric — runaway scale-up to maxDesired
[src/instance_tracker.ts:180](src/instance_tracker.ts#L180) — the metric switch in `track()` handles `jibri`/`sip-jibri` and the stress types but has **no `availability` case**, even though `stats()` ([src/instance_tracker.ts:103](src/instance_tracker.ts#L103)) and the autoscaler both treat availability like jibri. The metric falls through as `0` with `trackMetric = true`, so the group's "idle count" is always 0, `value < scaleUpThreshold` is true every period, and desired count climbs by `scaleUpQuantity` every grace period until `maxDesired` — and scale-down can never fire.

**Fix:** Add `case 'availability':` next to jibri, and add a `default:` that sets `trackMetric = false` so future types fail safe. Add an autoscaler test for an availability group with idle instances asserting no scale-up.

### 2. MCP tools accept `base_url`/`auth_token` overrides — credential-exfiltration and cross-environment-write primitive
Every one of the 18 tools takes an optional `base_url`, and [src/mcp/api_client.ts:28-31](src/mcp/api_client.ts#L28-L31) pairs the **default** `MCP_AUTH_TOKEN` bearer token with whatever URL is supplied. A hallucinated or prompt-injected parameter (group tags and sidecar-reported fields flow verbatim into tool output) sends the production JWT to an arbitrary host, including via "read-only" tools clients auto-approve. It also lets writes silently target the wrong autoscaler. CLAUDE.md says configuration is env-only — these params are undocumented.

**Fix:** Remove the overrides; if multi-target is needed, use an env-configured allowlist of named targets and never pair the default token with a non-default URL.

---

## High

### 3. `InstanceLauncher` takes no group lock, and provider calls have no timeouts — double-launch is possible
*(Found independently by three reviewers.)* AUTOSCALE and SCHEDULED_SCALING both lock the group, but [src/instance_launcher.ts:87](src/instance_launcher.ts#L87) doesn't. LAUNCH jobs are created every ~30s with a 180s timeout, and bee-queue's timeout doesn't cancel the running handler; OCI launch calls use `NoRetryConfigurationDetails` with no HTTP timeout and Nomad's `got` calls have none either. A slow launch overlaps the next cycle, both read the same `count < desired` gap, and both launch the full delta.

**Fix:** Wrap the launcher body in `lockGroup`/`finally release` like the autoscaler, and put timeouts on all provider calls.

### 4. "No metrics" is indistinguishable from "metric = 0" — silent walk to minDesired (stress groups) or maxDesired (jibri groups)
`getMetricInventoryPerPeriod` pre-allocates period arrays so the "No metrics available" guard at [src/autoscaler.ts:267](src/autoscaler.ts#L267) is dead code; `computeSummaryMetric([])` returns 0. A Prometheus data gap, a flushed `gmetric` zset, or `metricTTL` shorter than the scaling window quietly drains live capacity (or maxes it out).

**Fix:** Return NaN/undefined for empty periods and skip the cycle with the existing warn log; validate `scalePeriod × periodsCount ≤ METRIC_TTL_SEC` at group write time.

### 5. Editing scheduled scaling while a period is active permanently strands peak values and destroys the baseline
*(Found by two reviewers.)* In [src/handlers.ts:677-681](src/handlers.ts#L677-L681), when the updated config has no currently-active period, the handler deletes `scheduledScalingActivePeriod`/`scheduledScalingBaseOptions` **without restoring `scalingOptions`** — unlike the processor's natural exit path. Removing/renaming an active peak period (exactly what the MCP tools do) leaves the group scaled up forever, and the next period entry snapshots the poisoned values as the new baseline.

Related self-healing gaps: [src/scheduled_scaling_processor.ts:85](src/scheduled_scaling_processor.ts#L85) (disabled config strands active-period state) and [src/scheduled_scaling_processor.ts:157-163](src/scheduled_scaling_processor.ts#L157-L163) (missing baseline warn-loops forever without clearing tracking state).

**Fix:** Restore from baseline in the no-active-period branch, mirroring the processor's exit logic including the preserve-live-desiredCount rule. Make the processor self-heal in both gap cases. Add a test for "schedule edited mid-period to a config with no active period".

### 6. Shared OCI clients have `regionId` mutated per call — concurrent jobs can launch in the wrong region
[src/oracle_instance_manager.ts:54](src/oracle_instance_manager.ts#L54) mutates the shared `computeManagementClient`'s region before awaiting; with job concurrency 5 across multi-region groups, group A's launch can execute against group B's endpoint. A wrong-region instance is invisible to the (correctly region-scoped) search client — a billed orphan.

**Fix:** Per-region client map or per-call clients, as `getInstances` already does with `ResourceSearchClient`.

### 7. Partial launch failure discards successful launch IDs — real instances go untracked and unprotected
In [src/oracle_instance_manager.ts:148-199](src/oracle_instance_manager.ts#L148-L199), AD/FD selection runs outside the try block and can throw synchronously (missing AD after an `allSettled`-swallowed fault-domain fetch), rejecting the whole `Promise.all` while sibling launches succeed; `CloudManager.scaleUp` ([src/cloud_manager.ts:101](src/cloud_manager.ts#L101)) then throws before any `recordLaunch` — no tracking record, no audit event, no scale-down protection.

**Fix:** Make per-instance launches only resolve to `string | false`; validate fault-domain data before launching anything; use `Promise.allSettled` in `scaleUp` so successes are always recorded.

### 8. Instance listing is unpaginated — sanity loop and cloud guard see partial fleets
Oracle ignores `opcNextPage` ([src/oracle_instance_manager.ts:294-309](src/oracle_instance_manager.ts#L294-L309)); DigitalOcean fetches one page of 100 ([src/digital_ocean_instance_manager.ts:103](src/digital_ocean_instance_manager.ts#L103)) and maps `off`/unknown statuses to `Terminated`, hiding powered-off-but-billed droplets. Undercounting defeats the exact over-launch protection the cloud guard exists for.

**Fix:** Paginate both providers; map `off` to a non-terminated status; make the DO `default:` branch not mean "terminated".

### 9. ConsulStore's entire write path is fail-open — writes silently fail while callers get success
[src/consul.ts:445-456](src/consul.ts#L445-L456) `write()` catches everything and returns `false`; `upsertInstanceGroup`, `saveInstanceStatus`, `saveReservation`, `setScaleDownGrace` etc. report success anyway. In Consul mode, PUT /groups can 200 with nothing saved, and a dropped jobs-creation grace flag lets every node create duplicate job batches. JIT-16014 fixed the read side; the write side has the same class of bug.

Mirror issue in Redis: `setShutdownStatus`/`setShutdownConfirmation`/`setReconfigureDate` pipelines ignore `exec()` results ([src/redis.ts:245-361](src/redis.ts#L245-L361)).

**Fix:** Rethrow from `write()`/`writeTTLValue`; align both stores; route the Redis write pipelines through `execPipelineOrThrow`; add error-path parity cases to `store_contract.ts`.

### 10. The custom error handler is unreachable — registered before the routes
[src/app.ts:473](src/app.ts#L473) registers the 4-arg error middleware, but every route starts at line 502. Express only searches forward, so route errors hit the default finalhandler (full stack traces in responses when `NODE_ENV != production`). Verified empirically against the bundled express@4.21.2.

**Fix:** Move it after the last route; map body-parse errors (`entity.parse.failed`) to 400 while there; add a test that a throwing route returns the custom 500 body.

### 11. Health checks lie during outages
`/health?deep` runs on the metrics app with no context middleware, so `req.context` is undefined; `ConsulStore.ping` returns the caught **Error object** (truthy → "healthy") ([src/consul.ts:503-511](src/consul.ts#L503-L511)); with `maxRetriesPerRequest: null`, a Redis outage makes deep health **hang** rather than 500; and shallow `/health` says healthy while every real request is stuck in the offline queue.

**Fix:** Inject a context on `mapp`; return `false` from Consul ping's catch; add a `Promise.race` timeout around the deep check; reflect `redisClient.status` in shallow health.

### 12. Redis TTL silently evicts "take and hold" reservations
[src/redis.ts:581-588](src/redis.ts#L581-L588) sets `EX expiresAt+1h` on every reservation, but the take-and-hold contract (commit c302ef1, [src/reservation_manager.ts:62-66](src/reservation_manager.ts#L62-L66)) says held reservations survive past TTL when the group's autoscaling is off — the record is never re-saved, so Redis deletes it an hour after `expiresAt` and the hold vanishes without grace.

**Fix:** No TTL on non-terminal reservations (apply TTL on terminal status), or refresh TTLs during the hold sweep.

### 13. Reservations get marked Fulfilled before their capacity exists
[src/reservation_manager.ts:236-252](src/reservation_manager.ts#L236-L252) computes cumulative demand over `Active` reservations only, ignoring Fulfilled-but-unexpired ones that still hold nodes — a second reservation is reported Fulfilled while the running instances all belong to the first.

**Fix:** Accumulate over Active + Fulfilled (non-expired) sorted by `createdAt`; only transition Active ones actually covered. Add a test with a Fulfilled+Active mix.

---

## Medium

### API validation gaps (all let bad data into live scaling state)
- `PUT /groups/:name/scaling-activities` has zero validation ([src/app.ts:615](src/app.ts#L615)); `{"enableAutoScale": "false"}` stores a truthy string that behaves inconsistently across `== true` vs truthiness checks.
- `updateScalingOptions` applies unvalidated `gracePeriodTTLSec`/`cloudGuardGraceCount` ([src/handlers.ts:586-591](src/handlers.ts#L586-L591)); a bad TTL then makes every subsequent desired-count/upsert call on the group 500 (Redis rejects `EX NaN`).
- `launch-protected` commits the desiredCount bump **before** `setScaleDownProtected` can fail on an unvalidated `protectedTTLSec` — instances launch unprotected while the caller sees a 500 ([src/handlers.ts:503-557](src/handlers.ts#L503-L557)). Also: `canLaunchInstances` runs pre-lock (TOCTOU) and the `tags.length` block at lines 519-523 is dead code.
- `PUT /groups/:name` validates only 3 of ~10 scalingOptions fields, and `supportedInstanceType` is called **without `await`** at [src/app.ts:550](src/app.ts#L550), so any type string passes; unknown types then make launcher scale-down a silent no-op (no `default:` in [src/instance_launcher.ts:380-406](src/instance_launcher.ts#L380-L406)). The validator's type list rejects `stress`/`availability` while group_report and the full-scaling error message claim they're supported ([src/validator.ts:96-108](src/validator.ts#L96-L108)).
- Zero-value `scaleUpPeriodsCount`/`scalePeriod` throws `Reduce of empty array` in every autoscale job forever ([src/autoscaler.ts:486-494](src/autoscaler.ts#L486-L494)). Validate ≥1 at write time; give the reduce an initial value.
- Sidecar endpoints don't validate `group`/`instanceId`; unknown groups create **TTL-less Redis keys that grow forever** ([src/redis.ts:178-232](src/redis.ts#L178-L232)), and any token holder can shutdown-confirm arbitrary instances. Set TTLs at write time and/or reject reports for nonexistent groups.
- `PUT /groups/:name/desired` on a nonexistent group returns a 400 with an internal TypeError message instead of 404 ([src/validator.ts:65-78](src/validator.ts#L65-L78)).

### Authorization & auth robustness
- One JWT audience/issuer list guards everything: a sidecar credential can `DELETE /groups/:name` fleet-wide ([src/app.ts:462-471](src/app.ts#L462-L471)). Apply separate issuer/claim checks for `/sidecar/*` vs `/groups/*`.
- ASAP key fetch has no timeout, no negative caching, no fetch coalescing ([src/asap.ts:19-53](src/asap.ts#L19-L53)) — a hung key server pins the auth path; unknown kids amplify against the key server.
- `ASAP_JWT_ACCEPTED_HOOK_ISS.split(',')` doesn't trim — `"iss1, iss2"` silently breaks the second issuer ([src/config.ts:138](src/config.ts#L138)).

### Provider/store split-brain
`MetricsLoop.getUnTrackedCount`/`getCloudInstances` read raw Redis keys that Prometheus/Consul providers never write ([src/metrics_loop.ts:194-212](src/metrics_loop.ts#L194-L212)), silently disabling the launcher's untracked-count protections in those configurations. Route these through the store interfaces, or fail loudly at startup on unreadable provider combinations.

### Selenium grid / reservations
- Grid status fetch failure falls through as `queueSize = 0` and actively scales down, contradicting its own "using reservation floor only" log ([src/autoscaler.ts:379-420](src/autoscaler.ts#L379-L420)); a `/status` response missing `sessionQueueRequests` reads permanently as "no load". Treat unknown queue size as "hold current desired".
- Lazy expiry via GET polling skips `setScaleDownGrace` ([src/reservation_manager.ts:75-79](src/reservation_manager.ts#L75-L79)), defeating `RESERVATION_SCALE_DOWN_GRACE_SEC`.
- `extendReservation` is lockless read-modify-write and can resurrect a concurrently cancelled/expired reservation ([src/handlers.ts:910-927](src/handlers.ts#L910-L927)).
- `reservationScaleUpThreshold > 1` can starve small reservations until they expire unfulfilled ([src/autoscaler.ts:366-377](src/autoscaler.ts#L366-L377)).
- Consul `listReservations` matches by string prefix without a trailing slash, leaking reservations from `jvb-east-2` into `jvb-east` ([src/consul.ts:550-554](src/consul.ts#L550-L554)).

### Robustness
- `saveInstanceStatus` is fire-and-forget in `track()` ([src/instance_tracker.ts:173](src/instance_tracker.ts#L173)): sidecar gets 200 before persistence; a write failure eventually looks like a dead instance and triggers a replacement launch. `await` it.
- Nomad reports with empty `Gauges` crash the stats handler; NaN `stress_level` passes the `== undefined` guard and poisons the group average ([src/instance_tracker.ts:138-157](src/instance_tracker.ts#L138-L157)). Use `Number.isFinite`.
- Redis `listReservations` treats per-command pipeline errors as "expired" and permanently delists live reservations ([src/redis.ts:595-622](src/redis.ts#L595-L622)). Use `execPipelineOrThrow`.
- Consul locks renew indefinitely, so a hung job blocks its group until process restart; Redlock self-heals at TTL ([src/lock_manager.ts:129-179](src/lock_manager.ts#L129-L179)). Stop renewing past `groupLockTTLMs` or enforce deadlines on locked work.
- Group names interpolated unescaped into the OCI search query ([src/oracle_instance_manager.ts:289](src/oracle_instance_manager.ts#L289)) — validate names (`^[a-zA-Z0-9._-]+$`) at creation.
- OCI capacity retries compute the fault-domain index modulo the **AD** count, making retry-across-FDs a no-op in single-AD regions ([src/oracle_instance_manager.ts:157-160](src/oracle_instance_manager.ts#L157-L160)).
- Custom provider: empty script output is treated as launch failure though the script may have created a real instance, and `getInstances` returns `[]` so such orphans are undetectable ([src/custom_instance_manager.ts:118](src/custom_instance_manager.ts#L118)).
- `CloudManager.scaleDown`/`shutdownInstance` names and logs claim termination that never happens; no provider implements terminate, so instances with dead sidecars can never be reaped ([src/cloud_manager.ts:116-129](src/cloud_manager.ts#L116-L129)).
- Bulk full-scaling: a per-group throw after partial application rejects the whole `Promise.all` with no accounting of which groups updated ([src/scaling_options_manager.ts:54-62](src/scaling_options_manager.ts#L54-L62)).

### MCP server (beyond Critical #2)
- `create_group` is a blind PUT that silently replaces an existing group's full config ([src/mcp/tools/create_group.ts](src/mcp/tools/create_group.ts)). Check existence first; require an explicit overwrite flag.
- `update_group`'s GET→merge→PUT window writes back stale `desiredCount`, reverting concurrent autoscaler changes ([src/mcp/tools/update_group.ts](src/mcp/tools/update_group.ts)). Don't write back fields the caller didn't change; prefer the field-wise endpoints.
- No HTTP timeouts in the API client ([src/mcp/api_client.ts](src/mcp/api_client.ts)) — add `AbortSignal.timeout`.
- No `readOnlyHint`/`destructiveHint` annotations on any tool, so clients can't distinguish `search_groups` from `delete_group` for approval policies. Schemas accept floats/negatives (`z.number()` → `z.number().int().min(0)`).
- `get_group_audit` returns a plausible empty audit for nonexistent groups (handler never 404s), steering LLM diagnosis wrong.
- `add_scheduled_scaling_period` silently enables scheduled scaling and can apply capacity changes immediately; description omits both side effects.
- CLAUDE.md documents 13 of 18 tools (reservation tools missing); tests assert "all 10 tools".

---

## Cross-cutting build/deploy (verified directly)

- **Docker image will crash on Node ≥ 25**: `npm start` loads `src/polyfills.js` (SlowBuffer shim for jsonwebtoken's transitive dep `buffer-equal-constant-time`), but `tsc` never copies it to `dist/` and [build/run.sh](build/run.sh) execs node without it. `SlowBuffer` is confirmed `undefined` on Node 26. Only the `node:24` pin in the [Dockerfile](Dockerfile) prevents a startup crash today — a routine base-image bump breaks it. Copy polyfills into the image and load it in run.sh, or eliminate the SlowBuffer dependency.
- **Node version skew**: Dockerfile runs node:24, CI tests on 22.x, engines say >=20 — the shipped runtime is never tested. Align the CI matrix with the runtime image.
- **Dockerfile hygiene**: runs as root (no `USER node`); full Debian base with `linux-perf` baked into prod; deprecated `npm ci --only=production` (use `--omit=dev`).
- **Dependencies**: `redlock@5.0.0-beta.2` (a beta powering production locking — v5 never had a stable release); dual Redis clients (`redis@3.1.2` EOL, via bee-queue; `ioredis@5` for everything else); `got@11` (EOL).

---

## What's solid

Job-creation loops catch errors and always reschedule; locks are double-check gated and released in `finally`, with the JIT-16014 read-side fail-closed work (execPipelineOrThrow, checkValue, expiry unification) correct and well-tested; graceful shutdown (SIGTERM drain + force-exit timer) is right; ASAP kid handling is safe (sha256 before URL interpolation); timezone math in scheduled scaling is correct including DST/midnight wrap; restarts mid-scheduled-period restore correctly; reservation create/delete locking is consistent.

---

## Suggested fix order

1. **The two criticals:** `availability` metric case (one-line fix, prevents runaway launches) and removal of the MCP `base_url`/`auth_token` overrides.
2. **Launcher group lock + provider call timeouts** (closes double-launch), and treat "no metrics" as "skip cycle".
3. **Scheduled-scaling baseline restore** in the handler (data-loss bug reachable from the MCP tools today).
4. **OCI region-mutation and pagination fixes; Consul write-path rethrow.**
5. **Error-middleware ordering + health-check truthfulness** (cheap; they only matter during incidents — exactly when they must work).
6. **Validation hardening as a batch** (scaling-activities, scaling-options extras, launch-protected ordering, the missing `await` at app.ts:550).

## Test gaps worth closing alongside

- jibri/availability metric tracking (would have caught Critical #1)
- All-empty metric periods driving scaling decisions
- Concurrent launcher runs for the same group
- Fulfilled+Active reservation mixes; reservation threshold > 1
- Store-contract error-path parity between Redis and Consul
- Schedule edited mid-period to a config with no active period
