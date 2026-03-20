# Scheduled Scaling: Future Improvements

Known risks and recommended mitigations identified during architecture review, prioritized for future work.

## P1: Thundering Herd on Period Transitions

**Risk**: When many groups share the same timezone and period boundaries (e.g., all transition at 08:00 local), all groups attempt scaling changes simultaneously. This creates burst load on cloud provider APIs, potentially hitting rate limits and causing partial scale-up failures.

**Recommendation**: Add jitter (0-60s random delay) to the scheduled scaling job per group. Use a deterministic seed (e.g., hash of group name) so the offset is stable across processor runs but spread across groups. Consider a per-region or per-cloud launch rate limiter in `InstanceLauncher`.

## P1: Cliff-Drop at Period Boundaries

**Risk**: `inhibitScaleDown` only protects *within* an active period. When a period ends (e.g., peak → off-peak), the processor immediately applies the base or next period's `desiredCount`, which may be dramatically lower. For example, transitioning from peak (`desiredCount: 20`) to base (`desiredCount: 2`) causes an immediate 90% capacity reduction, even if active sessions are still running.

**Recommendation**:
- Add a `transitionGracePeriodMinutes` field to `SchedulePeriod` that delays scale-down for N minutes after period exit.
- Alternatively, when a transition reduces `desiredCount` by more than `scaleDownQuantity`, apply the reduction gradually over multiple processor cycles.
- At minimum, log a warning when a transition reduces `desiredCount` by more than `scaleDownQuantity` so operators can detect abrupt drops.

## P2: DELETE Leaves Group in Last-Applied State

**Risk**: `DELETE /groups/:name/scheduled-scaling` removes the `scheduledScaling` config but leaves `scalingOptions` at whatever the last active period set. If the group was in a low-capacity weekend period, deleting scheduled scaling on Monday morning leaves the group stuck at weekend capacity with no automatic recovery.

**Recommendation**: Document that deleting scheduled scaling leaves the group's current `scalingOptions` in place. The operator should manually update desired/min/max via `PUT /groups/:name/desired` after deleting if needed.

## P2: Region Timezone Map Incomplete

**Risk**: `REGION_TIMEZONE_MAP` in `scheduled_scaling_processor.ts` has 10 hardcoded entries. New OCI regions or non-OCI deployments silently fall through to `defaultTimezone` (UTC), causing scheduled scaling to operate on the wrong local time with no warning.

**Recommendation**:
- Log a warning when falling through to the default timezone via region mapping, so operators notice the misconfiguration.
- Make the region-to-timezone map configurable via environment variable (JSON string) so new regions can be added without code changes.

## Minor: startHour === endHour Ambiguity

**Risk**: `isHourInRange` treats *any* `startHour === endHour` as "all 24 hours" (not just `0 === 0`). A user setting `startHour: 14, endHour: 14` intending "only hour 14" would get "all day" instead.

**Recommendation**: Consider only treating `startHour === 0 && endHour === 0` as the all-day sentinel. Reject other equal pairs in input validation with a descriptive error.

## Minor: Lock Failure Alerting

**Risk**: Lock failures in `processScheduledScalingByGroup` are logged as warnings and counted in `scheduled_scaling_errors_total`, but there is no Prometheus alerting rule. Persistent lock failures would silently prevent scheduled scaling from operating.

**Recommendation**: Configure a Prometheus alerting rule for sustained non-zero `scheduled_scaling_errors_total` rate (e.g., > 0 for 5 minutes).

## Minor: @ts-nocheck in Tests

**Risk**: `src/test/scheduled_scaling_processor.ts` uses `@ts-nocheck`, disabling all TypeScript checking. Type-level regressions in the processor interface (e.g., renamed fields, changed signatures) won't be caught by tests.

**Recommendation**: Remove `@ts-nocheck` and properly type the mock objects, or use partial type assertions (`as unknown as Type`) for specific mocks.
