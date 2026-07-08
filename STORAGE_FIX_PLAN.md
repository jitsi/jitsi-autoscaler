# Storage & Lock Remediation Plan

Audit of the storage providers (`RedisStore`, `ConsulStore`, `PrometheusClient`) and lock
managers (`RedisLockManager`, `ConsulLockManager`) found the issues below. This document is
the implementation plan to fix all of them. Work through the workstreams in order; each
workstream is independently shippable as its own PR.

**Working assumption:** Consul mode (`INSTANCE_STORE_PROVIDER=consul`, `LOCK_PROVIDER=consul`)
has never worked in production — `ConsulStore.checkValue` always returns `true` (missing
`await`), which means `isGroupJobsCreationAllowed()` is always `false` and **no jobs are ever
created** in Consul mode. Therefore no data-migration/back-compat shims are needed for Consul
key layout changes. If this assumption is wrong, stop and confirm before Workstream 2.

**Verification for every workstream:** `npm run build` (lint + compile) and `npm test` must
pass. Add the regression tests listed in each item — tests live in `src/test/` using
`node:test` + `node:assert`, with mocks in `src/test/mock-redis-client.ts` and
`src/test/mock_store.ts`. Run a single file with
`npx ts-node -r ts-node/register src/test/<file>.ts`.

---

## Workstream 1 — RedisStore fixes (`src/redis.ts`)

Production-impacting; do this first.

### R1. Expired instance states are never deleted (unbounded hash growth) — HIGH
`fetchInstanceStates` (redis.ts:101-141) passes `groupInstancesStatesKey` (already
`instances:status:<group>`) as the `group` argument to `filterOutAndTrimExpiredStates`
(redis.ts:122-127). The trim path then re-derives the key, producing
`instances:status:instances:status:<group>`, so the `HDEL` pipeline targets a nonexistent
key. Expired states are filtered from results but never removed from Redis, and
`extendTTLForKey` keeps the hash alive forever.

**Fix:** pass `group` (the plain group name) to `filterOutAndTrimExpiredStates` inside
`fetchInstanceStates`.

**Test:** with the mock Redis client, seed a group hash with one fresh and one expired state
(expired = `timestamp` older than `idleTTL`), call `fetchInstanceStates`, assert the expired
entry was `HDEL`ed from `instances:status:<group>` and only the fresh state is returned.

### R2. `getShutdownConfirmation` signature diverges from the interface — MEDIUM (latent)
Interface (`instance_store.ts:194`) declares `(ctx, group, instanceId)`; the Redis
implementation (redis.ts:314) is `(ctx, instanceId)`. `ShutdownManager.getShutdownConfirmation`
(shutdown_manager.ts:40-41) forwards three args, so Redis would treat the group name as the
instance ID and always return `false`.

**Fix:** change the Redis signature to `(ctx: Context, _group: string, instanceId: string)`.
Update `src/test/shutdown_manager.ts` (currently calls with two args, masking the bug) and
`src/test/mock_store.ts` if needed.

**Test:** call through `ShutdownManager.getShutdownConfirmation(ctx, 'group', 'instance')`
against a store seeded with `instance:shutdownConfirmed:instance` and assert the confirmation
is found.

### R3. Pipelined reads treat per-command Redis errors as "flag not set" — MEDIUM
`getShutdownStatuses` (redis.ts:253), `getShutdownConfirmations` (redis.ts:270),
`areScaleDownProtected` (redis.ts:337), `getReconfigureDates` (redis.ts:381), and
`getInstanceStates` (redis.ts:143) inspect only `result[1]` of each pipeline entry and never
`result[0]` (the error). Under a flaky Redis, "error" reads as `false`/`''` — fail-open: a
shutting-down instance counts as active; a protected instance reads as unprotected and can be
scaled down.

**Fix:** in each of these methods, check `instance[0]`; if any command errored, log it with
context and **throw** (job-level try/catch in the processors already handles failures by
skipping the cycle, which is the safe behavior). Also apply to the `exec() === null` branches
that currently return `[]` (redis.ts:264-267, 285-288, 348-351, 392-395) — throw instead, for
the same reason. Note `doFilterOutAndTrimExpiredStates` (redis.ts:64) indexes into the result
of `getShutdownStatuses`; throwing keeps its indices aligned or aborts, both safe.

**Test:** mock a pipeline whose `exec()` returns `[[new Error('x'), null]]` and assert the
method throws rather than returning `[false]`.

### R4. Dead code using blocking `KEYS` — LOW
`fetchInstanceGroups` (redis.ts:165-168) uses `redisClient.keys('instances:status:*')` — a
blocking O(keyspace) command — and has no callers.

**Fix:** delete the method. (If it must stay, rewrite with `SCAN`.)

### R5. `deleteInstanceGroup` leaves reservation keys behind — LOW
redis.ts:509-527 deletes states/metrics/cloud-instances/untracked-count but not
`reservations:group:<name>` or its member `reservation:<id>` keys.

**Fix:** in `deleteInstanceGroup`, `SMEMBERS` the reservation set, add `DEL` for each
`reservation:<id>` plus the set itself to the pipeline.

**Test:** create a reservation, delete the group, assert both keys are gone.

### R6. Guard against missing `state.timestamp` — LOW
`doFilterOutAndTrimExpiredStates` (redis.ts:85) computes `new Date(state.timestamp + ...)`;
`timestamp` is optional on `InstanceState`, and `undefined` yields `NaN` → state treated as
expired and deleted. Probably unreachable via the sidecar path, but cheap to harden.

**Fix:** if `state.timestamp` is unset, treat the state as expired **and log a warning** (or
stamp it on save in `saveInstanceStatus`); just make the behavior explicit rather than an
accident of NaN comparison.

---

## Workstream 2 — ConsulStore fixes (`src/consul.ts`)

Goal: make Consul mode actually functional and semantically equivalent to Redis mode.

### C1. `checkValue` missing `await` — CRITICAL (one line)
consul.ts:374-384: `const res = this.fetchTTLValue(...)` — `res` is a Promise, always truthy,
so `checkValue` always returns `true`. Effects: no jobs are ever created
(job_manager.ts:267/306 via instance_group.ts:155/164), autoscaling permanently paused
(instance_group.ts:134), scale-down permanently inhibited (consul.ts:466).

**Fix:** `const res = await this.fetchTTLValue(ctx, this.valuesPrefix + key);` then
`return res !== undefined;`.

**Test:** `checkValue` returns `false` for missing key, `true` for unexpired value, `false`
for expired value.

### C2. Key-tree layout: group definitions mixed with group data — CRITICAL (design fix)
Group definitions live at `autoscaler/groups/<name>`, but per-group data is written under the
same prefix: `.../<name>/states/<id>`, `/shutdown/<id>`, `/confirmation/<id>`,
`/protected/<id>`, `/reconfigure/<id>`, `/instances`. `getAllInstanceGroups`
(consul.ts:232-242) and `getAllInstanceGroupNames` (consul.ts:224-230) recurse over the whole
prefix and parse every key as an `InstanceGroup`, so instance states come back cast as groups
and the job manager would create jobs for phantom groups named `mygroup/states/i-123`.

**Fix:** separate the trees. Keep group definitions at `autoscaler/groups/<name>` and move all
per-group data to a new prefix, e.g. `autoscaler/group-data/<name>/...`:
- Add `private groupDataPrefix = 'autoscaler/group-data/';` (make it constructor-configurable
  like the others).
- Update every read/write of `states`, `shutdown`, `confirmation`, `protected`, `reconfigure`,
  and `instances` (the `saveCloudInstances` key, consul.ts:389) to use
  `${this.groupDataPrefix}${group}/...`.
- `deleteInstanceGroup` (consul.ts:254-262) must now delete **both** the definition key and
  the group's data subtree (`kv.del({ key: `${groupDataPrefix}${group}/`, recurse: true })`).
- No migration needed per the working assumption above.

**Test:** save a group, save an instance state and a shutdown status for it, then assert
`getAllInstanceGroups` returns exactly one group and `getAllInstanceGroupNames` returns
exactly `['<name>']`.

### C3. Reconfigure paths inconsistent (write path ≠ read path ≠ delete path) — HIGH
- `setReconfigureDate` (consul.ts:172) writes to `${instancesPrefix}/reconfigure/<id>`
  (note: `instancesPrefix` already ends with `/`, producing a double slash).
- `getReconfigureDates` (consul.ts:185), `getReconfigureDate` (consul.ts:197), and
  `unsetReconfigureDate` (consul.ts:181) read/delete under `${groupsPrefix}${group}/reconfigure/`.
- Additionally `getReconfigureDates` (consul.ts:187) looks up `res[<full consul path>]`, but
  `fetchRecursiveTTLValues` keys its map by the **stripped** key (bare instance ID) — every
  lookup misses.
- `getReconfigureDate` (consul.ts:195-208) also ignores `expires` (no TTL check).

**Fix:** after C2, standardize all four methods on
`${this.groupDataPrefix}${group}/reconfigure/${instanceId}`:
- `setReconfigureDate` needs the group — it's available as `instance.group` on
  `InstanceDetails`.
- `getReconfigureDates`: look up `res[instanceId]` (stripped key).
- `getReconfigureDate`: use `fetchTTLValue` (which checks expiry) and return `v?.status ?? ''`.

**Test:** set a reconfigure date via `setReconfigureDate`, read it back with both
`getReconfigureDate` and `getReconfigureDates`, unset it, assert it's gone. Include an
expired entry and assert it reads as `''`.

### C4. Expired-value cleanup deletes the wrong keys — HIGH
`fetchRecursiveTTLValues` (consul.ts:308-329) builds its map keyed by the **stripped** key,
then `clean` calls `this.delete(k)` with that stripped key (e.g. bare `i-12345`) instead of
the full Consul path. Consul deletes of nonexistent keys succeed, so expired
shutdown/confirmation/protected/reservation entries are never actually removed — unbounded KV
garbage.

**Fix:** track both keys. E.g. build
`values: { [shortKey]: { fullKey, ttlValue } }` internally, delete by `fullKey`, and return
the `TTLValueMap` keyed by short key as before. Keep the in-memory filtering of expired
entries.

**Test:** seed an expired TTL value at `<prefix>/x`, call `fetchRecursiveTTLValues(ctx, prefix)`,
assert the mock consul client received `kv.del('<prefix>/x')` (full path) and the result map
is empty.

### C5. No instance-state expiry — HIGH
`filterOutAndTrimExpiredStates` is a no-op TODO (consul.ts:275-281) and `fetchInstanceStates`
does no timestamp checks, so crashed instances remain "running" forever and the launcher
under-provisions.

**Fix:** implement Redis-equivalent semantics:
- Add TTL options to `ConsulOptions`: `idleTTL`, `provisioningTTL`, `shutdownStatusTTL`
  (seconds). Wire them from config in `app.ts` exactly as the Redis branch does
  (app.ts:134-137).
- Implement `filterOutAndTrimExpiredStates` mirroring `RedisStore.doFilterOutAndTrimExpiredStates`
  (redis.ts:55-99): pick TTL by `provisioning` / shutting-down / idle, compare
  `state.timestamp + ttl*1000` to `Date.now()`, return only valid states, and delete expired
  ones from `${groupDataPrefix}${group}/states/<id>`. It can call `getShutdownStatuses`
  for the shutting-down check, same as Redis.
- Call it from `fetchInstanceStates` (with the plain group name — don't repeat R1).

**Test:** seed fresh + expired states; assert expired are deleted and excluded.

### C6. `fetchInstanceStates` crashes on empty group — MEDIUM
consul.ts:266-267: `kv.get({recurse})` returns `undefined` when no keys match;
`Object.entries(undefined)` throws.

**Fix:** `if (!states) return [];` before the `Object.entries` call (same guard as
`getAllInstanceGroups`).

**Test:** `fetchInstanceStates` on an unknown group returns `[]`.

### C7. `getReservation` full-scan + no cleanup — LOW
consul.ts:433-446 scans **all** reservations across all groups and matches by
`endsWith('/' + id)`; expired matches return `null` but stay in the KV.

**Fix (minimal):** delete the key when an expired reservation is found. Optionally accept an
optional `groupName` hint parameter for a direct lookup, but do not change the
`ReservationStore` interface without checking callers (`reservation_manager.ts`, handlers).

### C8. `existsAtLeastOneGroup` efficiency — LOW
consul.ts:397-400 fetches and parses every group. After C2, switch to
`kv.keys(this.groupsPrefix)`-style listing or reuse `getAllInstanceGroupNames` and check
length. Not urgent; correctness comes free with C2.

**Documentation note (no code change):** Consul TTL semantics are wall-clock timestamps
compared client-side (`writeTTLValue`, consul.ts:364-366). Add a comment stating that Consul
mode requires synchronized clocks across autoscaler nodes.

---

## Workstream 3 — PrometheusClient fixes (`src/prometheus.ts`)

### P1. Store errors indistinguishable from "no data" — HIGH
`prometheusRangeQuery` (prometheus.ts:104-120) catches errors and implicitly returns
`undefined`; `fetchInstanceMetrics` (prometheus.ts:143-161) then throws internally on
`res.result`, catches its own exception, and returns `[]`. A Prometheus outage silently reads
as "no stress metrics", and autoscaling stops making decisions without any store-level failure
signal. Redis mode throws in the same situation — the two MetricsStore providers must agree.

**Fix:** make `prometheusRangeQuery` rethrow after `promQueryErrors.inc()` + logging, and
remove the swallow-and-return-`[]` catch in `fetchInstanceMetrics` (let it propagate). Verify
the callers (`autoscaler.ts`, `metrics_loop.ts`, `instance_tracker.ts` — check with grep)
handle a thrown error by failing/skipping the cycle rather than crashing the process; the
AUTOSCALE job processor already wraps processing in try/catch.

**Test:** driver mock that rejects → `fetchInstanceMetrics` rejects (does not resolve `[]`).

### P2. Fixed 1-hour/60s query window ignores group scaling options — MEDIUM
prometheus.ts:105-107 hardcodes `start = now - 1h`, `step = 60`. Groups with
`scalePeriod × max(scaleUpPeriodsCount, scaleDownPeriodsCount) > 3600s` silently evaluate
truncated data; `scalePeriod < 60` gets coarser resolution than Redis mode.

**Fix:** extend `MetricsStore.fetchInstanceMetrics` to accept the window:
`fetchInstanceMetrics(ctx, group, windowSeconds?: number)` (optional param — Redis
implementation ignores it since it stores/cleans by `metricTTL`). In `PrometheusClient`,
use `start = now - max(windowSeconds, 3600) * 1000` and
`step = min(60, group scalePeriod)` — the caller computes
`windowSeconds = scalePeriod * max(scaleUpPeriodsCount, scaleDownPeriodsCount)`. Find the
call site (grep `fetchInstanceMetrics` — it's in `instance_tracker.ts` or `autoscaler.ts`)
and pass the value from the group's `scalingOptions`. Update `mock_store.ts`.

**Test:** assert the driver receives a range ≥ the configured window for a group with
`scalePeriod=300, scaleUpPeriodsCount=24` (2 hours).

### P3. Unescaped group name interpolated into PromQL — LOW
prometheus.ts:144. Group names come from the authenticated API, but a name containing `"` or
`\` breaks the query.

**Fix:** add a small `escapeLabelValue(v: string)` (backslash-escape `\`, `"`, and newline)
and use it for the `group` label in both `fetchInstanceMetrics` and any other interpolated
query.

---

## Workstream 4 — Lock manager fixes (`src/lock_manager.ts`)

### L1. Consul session renewal: unhandled rejection + permanent lockout — CRITICAL
`renewConsulSession` (lock_manager.ts:85-96) runs from a bare `setTimeout`; a single failed
renew is an unhandled rejection (process crash on Node ≥15), the renewal chain stops, and
`consulSession` keeps the dead session ID forever, so every future `lockKey` fails.

**Fix:**
- Wrap the renew call in try/catch. On failure: log, clear `this.consulSession` (and the
  timer), so the next `initConsulSession()` creates a fresh session.
- `initConsulSession` should be called per `lockKey` (it already is) and recover from a dead
  session: if `kv.set({acquire})` fails with an invalid-session error, clear
  `this.consulSession`, re-init once, and retry the acquire once.

### L2. Configured lock TTLs ignored; crash stalls a group for up to 1h — HIGH
`groupLockTTLMs`/`jobCreationLockTTL` are accepted (lock_manager.ts:15-20, app.ts:222-226) but
never used; the shared session has a hardcoded `'1h'` TTL (lock_manager.ts:57) with 30-minute
renewals.

**Fix:** shorten the session so crash-stall is bounded: set `consulSessionTTL = '90s'` and
`consulSessionRenewInterval = 30_000` (renew at ⅓ of TTL; Consul minimum session TTL is 10s).
This bounds a crashed node's lock hold to ~90s, in the same ballpark as the Redis TTLs.
Either use the passed-in TTL options to derive these values or remove them from
`ConsulLockManagerOptions` — don't leave dead config. Keep `behavior: 'release'`.

### L3. Session-creation race leaks sessions and timers — MEDIUM
Concurrent first-time `lockKey` calls both create sessions; the loser's session and renewal
timer leak (lock_manager.ts:71-83).

**Fix:** memoize creation as a single in-flight promise:
`private sessionPromise?: Promise<string>` — `initConsulSession` returns the existing promise
if set, clears it on failure. All the L1 "clear session" paths must clear the promise too.

### L4. `release()` throws from `finally` blocks — MEDIUM (both providers)
`ConsulLocker.release` (lock_manager.ts:33-39) propagates `kv.set` errors;
`RedLocker.release` (lock_manager.ts:48-51) propagates redlock's expired-lock error. All
callers release in `finally` (job_manager.ts:301, 359; same pattern in the group processors),
so a release failure masks the original error.

**Fix:** wrap both `release()` bodies in try/catch — log at `warn` level (an expired redlock
release is expected when a job overruns its TTL; say so in the message) and never throw.

**Test:** a `RedLocker` whose inner `lock.release()` rejects → `release(ctx)` resolves.

### L5. No acquire retry on Consul contention — LOW
Redis (redlock) retries 3× with jitter; Consul throws on first contention. Align by retrying
the `kv.set({acquire})` up to 3 times with ~200ms jittered delay before throwing. (Callers
already treat a throw as "skip this cycle", so this is throughput polish, not correctness.)

### L6. Redlock single-client TODO — NO ACTION
Documented limitation (lock_manager.ts:149). Leave as-is; do not attempt multi-node Redlock in
this pass.

---

## Workstream 5 — Interface & test hardening

1. **Make signature drift impossible:** the `InstanceStore` interface is defined with
   object-literal method properties, so TypeScript's bivariance let R2 slip through. Where
   trivial, ensure both stores declare parameters exactly as the interface does (including
   `_group`-style unused params, per lint convention). Consider changing interface members to
   method signatures with `strictFunctionTypes`-friendly declarations if that catches drift —
   verify it actually errors on a 2-arg implementation before claiming it does.
2. **Mock store parity:** update `src/test/mock_store.ts` so every mocked method matches the
   real interface arity (it currently mirrors the buggy 2-arg `getShutdownConfirmation`).
3. **Cross-provider contract test:** add `src/test/store_contract.ts` that runs the same
   scenario suite (save/fetch/expire states; set/get shutdown status+confirmation; protect;
   reconfigure set/get/unset; group CRUD + listing purity; setValue/checkValue with expiry;
   reservations save/list/delete/grace) against **both** `RedisStore` (mock redis) and
   `ConsulStore` (mock consul client, following the existing pattern in `src/test/consul.ts`).
   This is the single highest-leverage guard against future divergence.
4. **Lint/build:** `npm run build` must pass; CI needs `NODE_OPTIONS=--max-old-space-size=8192`
   (already documented in CLAUDE.md).

---

## Suggested PR breakdown & order

| PR | Contents | Risk |
|----|----------|------|
| 1 | Workstream 1 (Redis) — R1 first, it's the live production leak | Low, high value |
| 2 | Workstream 4 (locks) — L1/L2/L3 Consul session lifecycle, L4 release-safety, L5 retry | Low |
| 3 | Workstream 3 (Prometheus) — P1 error propagation, P2 window, P3 escaping | Medium (P1 changes failure behavior — verify job-level catch paths) |
| 4 | Workstream 2 (Consul store) — C1 + C2 layout + C3–C8, plus TTL wiring in app.ts | Larger; gated on the "Consul never worked" assumption |
| 5 | Workstream 5 — contract tests + mock parity (can also be folded into PRs 1–4) | Low |

Each PR: run `npm run build && npm test`, and include the regression tests named above.
Do not commit or push without explicit approval from the repo owner.
