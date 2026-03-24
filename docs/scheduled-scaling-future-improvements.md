# Scheduled Scaling: Architecture Review & Future Improvements

Known risks and recommended mitigations identified during architecture review, prioritized for future work.

Items marked **[RESOLVED]** have been addressed in the boundary-crossing refactor.

## [RESOLVED] P0: Admin Overrides Silently Reverted Every 30s

**Risk**: The processor ran every ~30s and overwrote `scalingOptions` to match the active period's target. If an admin used `PUT /groups/:name/desired` to emergency-scale a group, the next processor cycle would revert their change back to the period's values within seconds.

**Resolution**: The processor now uses a boundary-crossing model. It only writes changes when a period starts or ends (tracked via `scheduledScalingActivePeriod`). While the same period is active, admin changes are untouched.

## [RESOLVED] P0: No Baseline Restore When No Period Active

**Risk**: When a period ended and no other period matched, the processor did nothing. The group's `scalingOptions` stayed frozen at whatever the last period set, with no way to restore the pre-scheduled-scaling state.

**Resolution**: When the first period is entered, the group's current `scalingOptions` are snapshotted to `scheduledScalingBaseOptions`. When all periods end, the baseline is restored. DELETE also restores the baseline.

## [RESOLVED] P1: DELETE Leaves Group in Last-Applied State

**Risk**: `DELETE /groups/:name/scheduled-scaling` removed the config but left `scalingOptions` at whatever the last active period set.

**Resolution**: DELETE now restores `scheduledScalingBaseOptions` if present and re-enables `enableScheduler`.

## P1: Thundering Herd on Period Transitions

**Risk**: When many groups share the same timezone and period boundaries (e.g., all transition at 08:00 local), all groups attempt scaling changes simultaneously. This creates burst load on cloud provider APIs, potentially hitting rate limits and causing partial scale-up failures.

**Recommendation**: Add jitter (0-60s random delay) to the scheduled scaling job per group. Use a deterministic seed (e.g., hash of group name) so the offset is stable across processor runs but spread across groups. Consider a per-region or per-cloud launch rate limiter in `InstanceLauncher`.

## P1: Cliff-Drop at Period Boundaries

**Risk**: `inhibitScaleDown` only protects *within* an active period. When a period ends (e.g., peak -> off-peak), the processor immediately applies the base or next period's `desiredCount`, which may be dramatically lower. For example, transitioning from peak (`desiredCount: 20`) to base (`desiredCount: 2`) causes an immediate 90% capacity reduction, even if active sessions are still running.

**Recommendation**:
- Add a `transitionGracePeriodMinutes` field to `SchedulePeriod` that delays scale-down for N minutes after period exit.
- Alternatively, when a transition reduces `desiredCount` by more than `scaleDownQuantity`, apply the reduction gradually over multiple processor cycles.
- At minimum, log a warning when a transition reduces `desiredCount` by more than `scaleDownQuantity` so operators can detect abrupt drops.

## [RESOLVED] P1: desiredCount: 0 Allowed Without Safeguard

**Risk**: The API validation allows `desiredCount: 0` via `isInt({ min: 0 })`. Combined with `minDesired: 0, maxDesired: 0`, a misconfigured period could scale a production group to zero instances.

**Resolution**: A warning is now logged when a scheduled scaling period resolves to `desiredCount: 0`, both at config enable time (handler) and at period boundary crossings (processor). Operators can detect misconfigurations via log monitoring or alerting.

## [RESOLVED] P1: Midnight-Wrapping Periods + dayOfWeek Interaction

**Risk**: A period with `startHour: 22, endHour: 6, dayOfWeek: [1]` (Monday) is ambiguous. The `isTimeInRange` check and `dayOfWeek` check are independent: on Tuesday at 03:00, `dayOfWeek` is Tuesday (2), which is NOT in `[1]`, so the period is not active even though it logically started Monday at 22:00.

**Resolution**: `findActivePeriod` now checks both today's and yesterday's periods for midnight-wrapping ranges. The post-midnight portion of a wrapping period matches when yesterday's day-of-week is in the period's `dayOfWeek` array. The all-day sentinel (`start === end`) is excluded from wrap detection to avoid false matches.

## P2: Region Timezone Map Incomplete

**Risk**: `REGION_TIMEZONE_MAP` in `scheduled_scaling_processor.ts` has 10 hardcoded entries. New OCI regions or non-OCI deployments silently fall through to `defaultTimezone` (UTC), causing scheduled scaling to operate on the wrong local time with no warning.

**Recommendation**:
- Log a warning when falling through to the default timezone via region mapping, so operators notice the misconfiguration.
- Make the region-to-timezone map configurable via environment variable (JSON string) so new regions can be added without code changes.

## P2: Unbounded Prometheus Cardinality

**Risk**: `scheduledScalingActivePeriodGauge` uses `{ group, period }` labels. Period names are free-text strings. If operators create many uniquely-named periods or typo names, this creates unbounded label cardinality.

**Recommendation**: Consider using a hash or index instead of the raw period name, or cap the number of periods per group.

## P2: Lock Failure Silently Skips Processing

**Risk**: Lock failures return `false` with only a warning log. If Redis is degraded, all scheduled scaling processing silently stops. The `scheduled_scaling_errors_total` counter increments but without an alerting rule this goes unnoticed.

**Recommendation**: Configure a Prometheus alerting rule for sustained non-zero `scheduled_scaling_errors_total` rate (e.g., > 0 for 5 minutes).

## Minor: startHour === endHour Ambiguity

**Risk**: `isTimeInRange` treats *any* `startHour === endHour` (and `startMinute === endMinute`) as "all 24 hours". A user setting `startHour: 14, endHour: 14` intending "only hour 14" would get "all day" instead.

**Recommendation**: Consider only treating `startHour === 0 && endHour === 0` as the all-day sentinel. Reject other equal pairs in input validation with a descriptive error.

## Minor: @ts-nocheck in Tests

**Risk**: `src/test/scheduled_scaling_processor.ts` uses `@ts-nocheck`, disabling all TypeScript checking. Type-level regressions in the processor interface won't be caught by tests.

**Recommendation**: Remove `@ts-nocheck` and properly type the mock objects, or use partial type assertions (`as unknown as Type`) for specific mocks.

## [RESOLVED] Minor: deleteScheduledScaling Audit Trail

**Risk**: Unlike `updateScheduledScaling`, deleting the config produces no audit trail.

**Resolution**: `deleteScheduledScaling` now records a `scheduledScalingDeleted` audit entry capturing the previous config, active period, and desiredCount change.
