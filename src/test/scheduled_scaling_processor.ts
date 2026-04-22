/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck

import assert from 'node:assert';
import test, { afterEach, describe, mock } from 'node:test';

import ScheduledScalingProcessor from '../scheduled_scaling_processor';

function log(msg, obj) {
    console.log(msg, JSON.stringify(obj));
}

function initContext() {
    return {
        logger: {
            info: mock.fn(log),
            debug: mock.fn(log),
            error: mock.fn(log),
            warn: mock.fn(log),
        },
    };
}

const currentScalingOptions = {
    minDesired: 1,
    maxDesired: 5,
    desiredCount: 2,
    scaleUpQuantity: 1,
    scaleDownQuantity: 1,
    scaleUpThreshold: 0.8,
    scaleDownThreshold: 0.3,
    scalePeriod: 60,
    scaleUpPeriodsCount: 2,
    scaleDownPeriodsCount: 4,
};

const peakPeriod = {
    name: 'weekday-peak',
    dayOfWeek: [1, 2, 3, 4, 5],
    startHour: 8,
    endHour: 20,
    priority: 10,
    inhibitScaleDown: true,
    scalingOptions: { minDesired: 10, maxDesired: 20, desiredCount: 10 },
};

const weekendPeriod = {
    name: 'weekend',
    dayOfWeek: [0, 6],
    startHour: 0,
    endHour: 0,
    priority: 20,
    scalingOptions: { minDesired: 0, maxDesired: 2, desiredCount: 1 },
};

describe('ScheduledScalingProcessor', () => {
    describe('getLocalTime', () => {
        test('converts UTC time to Eastern timezone', () => {
            // 2026-03-18 is a Wednesday. 18:00 UTC = 14:00 ET (EDT)
            const now = new Date('2026-03-18T18:00:00Z');
            const result = ScheduledScalingProcessor.getLocalTime(now, 'America/New_York');
            assert.strictEqual(result.dayOfWeek, 3); // Wednesday
            assert.strictEqual(result.hour, 14);
            assert.strictEqual(result.minute, 0);
        });

        test('converts UTC time to Tokyo timezone', () => {
            // 2026-03-18 18:00 UTC = 2026-03-19 03:00 JST (next day, Thursday)
            const now = new Date('2026-03-18T18:00:00Z');
            const result = ScheduledScalingProcessor.getLocalTime(now, 'Asia/Tokyo');
            assert.strictEqual(result.dayOfWeek, 4); // Thursday
            assert.strictEqual(result.hour, 3);
            assert.strictEqual(result.minute, 0);
        });

        test('handles day boundary crossing for Sydney', () => {
            // 2026-03-20 (Friday) 15:00 UTC = 2026-03-21 (Saturday) 02:00 AEDT
            const now = new Date('2026-03-20T15:00:00Z');
            const result = ScheduledScalingProcessor.getLocalTime(now, 'Australia/Sydney');
            assert.strictEqual(result.dayOfWeek, 6); // Saturday
            assert.strictEqual(result.hour, 2);
            assert.strictEqual(result.minute, 0);
        });

        test('returns correct minutes', () => {
            // 2026-03-18 18:45 UTC = 14:45 ET
            const now = new Date('2026-03-18T18:45:00Z');
            const result = ScheduledScalingProcessor.getLocalTime(now, 'America/New_York');
            assert.strictEqual(result.hour, 14);
            assert.strictEqual(result.minute, 45);
        });
    });

    describe('isTimeInRange', () => {
        test('normal range (8:00-20:00): inside', () => {
            assert.strictEqual(ScheduledScalingProcessor.isTimeInRange(12, 0, 8, 0, 20, 0), true);
        });

        test('normal range (8:00-20:00): at start', () => {
            assert.strictEqual(ScheduledScalingProcessor.isTimeInRange(8, 0, 8, 0, 20, 0), true);
        });

        test('normal range (8:00-20:00): at end (exclusive)', () => {
            assert.strictEqual(ScheduledScalingProcessor.isTimeInRange(20, 0, 8, 0, 20, 0), false);
        });

        test('normal range (8:00-20:00): outside', () => {
            assert.strictEqual(ScheduledScalingProcessor.isTimeInRange(6, 0, 8, 0, 20, 0), false);
        });

        test('midnight wrap (22:00-6:00): before midnight', () => {
            assert.strictEqual(ScheduledScalingProcessor.isTimeInRange(23, 0, 22, 0, 6, 0), true);
        });

        test('midnight wrap (22:00-6:00): after midnight', () => {
            assert.strictEqual(ScheduledScalingProcessor.isTimeInRange(3, 0, 22, 0, 6, 0), true);
        });

        test('midnight wrap (22:00-6:00): outside', () => {
            assert.strictEqual(ScheduledScalingProcessor.isTimeInRange(12, 0, 22, 0, 6, 0), false);
        });

        test('all-day (0:00-0:00): matches any time', () => {
            assert.strictEqual(ScheduledScalingProcessor.isTimeInRange(0, 0, 0, 0, 0, 0), true);
            assert.strictEqual(ScheduledScalingProcessor.isTimeInRange(12, 30, 0, 0, 0, 0), true);
            assert.strictEqual(ScheduledScalingProcessor.isTimeInRange(23, 59, 0, 0, 0, 0), true);
        });

        test('minute-level range (7:45-8:00): inside at 7:45', () => {
            assert.strictEqual(ScheduledScalingProcessor.isTimeInRange(7, 45, 7, 45, 8, 0), true);
        });

        test('minute-level range (7:45-8:00): inside at 7:50', () => {
            assert.strictEqual(ScheduledScalingProcessor.isTimeInRange(7, 50, 7, 45, 8, 0), true);
        });

        test('minute-level range (7:45-8:00): outside at 8:00 (exclusive)', () => {
            assert.strictEqual(ScheduledScalingProcessor.isTimeInRange(8, 0, 7, 45, 8, 0), false);
        });

        test('minute-level range (7:45-8:00): outside at 7:44', () => {
            assert.strictEqual(ScheduledScalingProcessor.isTimeInRange(7, 44, 7, 45, 8, 0), false);
        });

        test('midnight wrap with minutes (23:30-0:15): before midnight', () => {
            assert.strictEqual(ScheduledScalingProcessor.isTimeInRange(23, 45, 23, 30, 0, 15), true);
        });

        test('midnight wrap with minutes (23:30-0:15): after midnight', () => {
            assert.strictEqual(ScheduledScalingProcessor.isTimeInRange(0, 10, 23, 30, 0, 15), true);
        });

        test('midnight wrap with minutes (23:30-0:15): outside', () => {
            assert.strictEqual(ScheduledScalingProcessor.isTimeInRange(0, 15, 23, 30, 0, 15), false);
        });
    });

    describe('findActivePeriod', () => {
        const config = {
            enabled: true,
            periods: [peakPeriod, weekendPeriod],
        };

        test('returns peak period during weekday peak hours', () => {
            // Wednesday 14:00 ET
            const now = new Date('2026-03-18T18:00:00Z');
            const result = ScheduledScalingProcessor.findActivePeriod(config, now, 'America/New_York');
            assert.strictEqual(result.name, 'weekday-peak');
        });

        test('returns null during weekday off-peak hours', () => {
            // Wednesday 22:00 ET (02:00 UTC Thursday)
            const now = new Date('2026-03-19T03:00:00Z');
            const result = ScheduledScalingProcessor.findActivePeriod(config, now, 'America/New_York');
            assert.strictEqual(result, null);
        });

        test('returns weekend period on Saturday', () => {
            // Saturday 12:00 ET
            const now = new Date('2026-03-21T16:00:00Z');
            const result = ScheduledScalingProcessor.findActivePeriod(config, now, 'America/New_York');
            assert.strictEqual(result.name, 'weekend');
        });

        test('returns weekend period on Sunday', () => {
            // Sunday 10:00 ET
            const now = new Date('2026-03-22T14:00:00Z');
            const result = ScheduledScalingProcessor.findActivePeriod(config, now, 'America/New_York');
            assert.strictEqual(result.name, 'weekend');
        });

        test('returns null with empty periods array', () => {
            const emptyConfig = { enabled: true, periods: [] };
            const now = new Date('2026-03-18T18:00:00Z');
            const result = ScheduledScalingProcessor.findActivePeriod(emptyConfig, now, 'America/New_York');
            assert.strictEqual(result, null);
        });

        test('higher priority wins when periods overlap', () => {
            const overlappingConfig = {
                enabled: true,
                periods: [
                    { ...peakPeriod, dayOfWeek: [0, 1, 2, 3, 4, 5, 6], priority: 10 },
                    { ...weekendPeriod, startHour: 8, endHour: 20, priority: 20 },
                ],
            };
            // Saturday 12:00 ET — both match, weekend has higher priority
            const now = new Date('2026-03-21T16:00:00Z');
            const result = ScheduledScalingProcessor.findActivePeriod(overlappingConfig, now, 'America/New_York');
            assert.strictEqual(result.name, 'weekend');
        });

        test('midnight-wrapping period matches on next day (post-midnight)', () => {
            const nightConfig = {
                enabled: true,
                periods: [
                    {
                        name: 'night-shift',
                        dayOfWeek: [1], // Monday
                        startHour: 22,
                        endHour: 6,
                        priority: 10,
                        scalingOptions: { minDesired: 5 },
                    },
                ],
            };
            // Tuesday 03:00 UTC — period started Monday 22:00, should still be active
            const now = new Date('2026-03-17T03:00:00Z'); // Tuesday
            const result = ScheduledScalingProcessor.findActivePeriod(nightConfig, now, 'UTC');
            assert.strictEqual(result.name, 'night-shift');
        });

        test('midnight-wrapping period matches on start day (pre-midnight)', () => {
            const nightConfig = {
                enabled: true,
                periods: [
                    {
                        name: 'night-shift',
                        dayOfWeek: [1], // Monday
                        startHour: 22,
                        endHour: 6,
                        priority: 10,
                        scalingOptions: { minDesired: 5 },
                    },
                ],
            };
            // Monday 23:00 UTC
            const now = new Date('2026-03-16T23:00:00Z'); // Monday
            const result = ScheduledScalingProcessor.findActivePeriod(nightConfig, now, 'UTC');
            assert.strictEqual(result.name, 'night-shift');
        });

        test('midnight-wrapping period does not match on start day post-midnight (wrong previous day)', () => {
            const nightConfig = {
                enabled: true,
                periods: [
                    {
                        name: 'night-shift',
                        dayOfWeek: [1], // Monday
                        startHour: 22,
                        endHour: 6,
                        priority: 10,
                        scalingOptions: { minDesired: 5 },
                    },
                ],
            };
            // Monday 03:00 UTC — Sunday is not in dayOfWeek, so no match
            const now = new Date('2026-03-16T03:00:00Z'); // Monday
            const result = ScheduledScalingProcessor.findActivePeriod(nightConfig, now, 'UTC');
            assert.strictEqual(result, null);
        });

        test('Saturday-to-Sunday midnight wrap matches on Sunday', () => {
            const satNightConfig = {
                enabled: true,
                periods: [
                    {
                        name: 'sat-night',
                        dayOfWeek: [6], // Saturday
                        startHour: 23,
                        endHour: 2,
                        priority: 10,
                        scalingOptions: { minDesired: 3 },
                    },
                ],
            };
            // Sunday 01:00 UTC
            const now = new Date('2026-03-22T01:00:00Z'); // Sunday
            const result = ScheduledScalingProcessor.findActivePeriod(satNightConfig, now, 'UTC');
            assert.strictEqual(result.name, 'sat-night');
        });

        test('all-day sentinel does not false-match via yesterday logic', () => {
            const allDayConfig = {
                enabled: true,
                periods: [
                    {
                        name: 'wed-all-day',
                        dayOfWeek: [3], // Wednesday
                        startHour: 0,
                        endHour: 0,
                        priority: 10,
                        scalingOptions: { minDesired: 5 },
                    },
                ],
            };
            // Thursday 10:00 UTC — should NOT match (all-day sentinel is not a wrap)
            const now = new Date('2026-03-19T10:00:00Z'); // Thursday
            const result = ScheduledScalingProcessor.findActivePeriod(allDayConfig, now, 'UTC');
            assert.strictEqual(result, null);
        });

        test('weekday midnight-wrapping period matches Saturday morning (Friday in list)', () => {
            const weekdayNightConfig = {
                enabled: true,
                periods: [
                    {
                        name: 'weekday-night',
                        dayOfWeek: [1, 2, 3, 4, 5], // Mon-Fri
                        startHour: 22,
                        endHour: 6,
                        priority: 10,
                        scalingOptions: { minDesired: 5 },
                    },
                ],
            };
            // Saturday 03:00 UTC — Friday is in dayOfWeek, should match
            const now = new Date('2026-03-21T03:00:00Z'); // Saturday
            const result = ScheduledScalingProcessor.findActivePeriod(weekdayNightConfig, now, 'UTC');
            assert.strictEqual(result.name, 'weekday-night');
        });

        test('weekday midnight-wrapping period does not match Sunday morning (Saturday not in list)', () => {
            const weekdayNightConfig = {
                enabled: true,
                periods: [
                    {
                        name: 'weekday-night',
                        dayOfWeek: [1, 2, 3, 4, 5], // Mon-Fri
                        startHour: 22,
                        endHour: 6,
                        priority: 10,
                        scalingOptions: { minDesired: 5 },
                    },
                ],
            };
            // Sunday 03:00 UTC — Saturday (6) is NOT in dayOfWeek
            const now = new Date('2026-03-22T03:00:00Z'); // Sunday
            const result = ScheduledScalingProcessor.findActivePeriod(weekdayNightConfig, now, 'UTC');
            assert.strictEqual(result, null);
        });

        test('priority resolution across day boundaries', () => {
            const crossDayConfig = {
                enabled: true,
                periods: [
                    {
                        name: 'yesterday-wrap',
                        dayOfWeek: [1], // Monday
                        startHour: 22,
                        endHour: 10,
                        priority: 10,
                        scalingOptions: { minDesired: 5 },
                    },
                    {
                        name: 'today-morning',
                        dayOfWeek: [2], // Tuesday
                        startHour: 6,
                        endHour: 12,
                        priority: 20,
                        scalingOptions: { minDesired: 15 },
                    },
                ],
            };
            // Tuesday 08:00 UTC — both match, today-morning (pri 20) should win
            const now = new Date('2026-03-17T08:00:00Z'); // Tuesday
            const result = ScheduledScalingProcessor.findActivePeriod(crossDayConfig, now, 'UTC');
            assert.strictEqual(result.name, 'today-morning');
        });
    });

    describe('resolveActiveScalingOptions', () => {
        const config = {
            enabled: true,
            periods: [peakPeriod, weekendPeriod],
        };

        test('returns peak options during weekday peak hours', () => {
            const now = new Date('2026-03-18T18:00:00Z'); // Wednesday 14:00 ET
            const result = ScheduledScalingProcessor.resolveActiveScalingOptions(
                config,
                currentScalingOptions,
                now,
                'America/New_York',
            );
            assert.strictEqual(result.minDesired, 10);
            assert.strictEqual(result.maxDesired, 20);
            assert.strictEqual(result.desiredCount, 10);
            // Non-overridden values should come from current options
            assert.strictEqual(result.scaleUpQuantity, 1);
            assert.strictEqual(result.scalePeriod, 60);
        });

        test('returns null during weekday off-peak (no active period)', () => {
            const now = new Date('2026-03-19T03:00:00Z'); // Wednesday 22:00 ET
            const result = ScheduledScalingProcessor.resolveActiveScalingOptions(
                config,
                currentScalingOptions,
                now,
                'America/New_York',
            );
            assert.strictEqual(result, null);
        });

        test('returns weekend options on Saturday', () => {
            const now = new Date('2026-03-21T16:00:00Z'); // Saturday 12:00 ET
            const result = ScheduledScalingProcessor.resolveActiveScalingOptions(
                config,
                currentScalingOptions,
                now,
                'America/New_York',
            );
            assert.strictEqual(result.minDesired, 0);
            assert.strictEqual(result.maxDesired, 2);
            assert.strictEqual(result.desiredCount, 1);
        });

        test('enforces minDesired <= desiredCount', () => {
            const badConfig = {
                enabled: true,
                periods: [
                    {
                        name: 'bad',
                        dayOfWeek: [0, 1, 2, 3, 4, 5, 6],
                        startHour: 0,
                        endHour: 0,
                        priority: 10,
                        scalingOptions: { minDesired: 10, desiredCount: 5 },
                    },
                ],
            };
            const now = new Date('2026-03-18T18:00:00Z');
            const result = ScheduledScalingProcessor.resolveActiveScalingOptions(
                badConfig,
                currentScalingOptions,
                now,
                'America/New_York',
            );
            assert.ok(result.desiredCount >= result.minDesired);
        });

        test('enforces maxDesired >= desiredCount', () => {
            const badConfig = {
                enabled: true,
                periods: [
                    {
                        name: 'bad',
                        dayOfWeek: [0, 1, 2, 3, 4, 5, 6],
                        startHour: 0,
                        endHour: 0,
                        priority: 10,
                        scalingOptions: { maxDesired: 3, desiredCount: 10 },
                    },
                ],
            };
            const now = new Date('2026-03-18T18:00:00Z');
            const result = ScheduledScalingProcessor.resolveActiveScalingOptions(
                badConfig,
                currentScalingOptions,
                now,
                'America/New_York',
            );
            assert.ok(result.maxDesired >= result.desiredCount);
        });
    });

    describe('mergeWithLiveDesired', () => {
        test('preserves live desiredCount when period does not specify it', () => {
            const base = { ...currentScalingOptions, desiredCount: 5 };
            const live = { ...currentScalingOptions, desiredCount: 12 };
            const periodOverrides = { minDesired: 8 };
            const result = ScheduledScalingProcessor.mergeWithLiveDesired(base, live, periodOverrides);
            assert.strictEqual(result.desiredCount, 12);
            assert.strictEqual(result.minDesired, 8);
        });

        test('uses period desiredCount when explicitly specified', () => {
            const base = { ...currentScalingOptions, desiredCount: 5 };
            const live = { ...currentScalingOptions, desiredCount: 12 };
            const periodOverrides = { minDesired: 8, desiredCount: 10 };
            const result = ScheduledScalingProcessor.mergeWithLiveDesired(base, live, periodOverrides);
            assert.strictEqual(result.desiredCount, 10);
        });

        test('applies invariants: live desiredCount below new minDesired is bumped', () => {
            const base = { ...currentScalingOptions, desiredCount: 5 };
            const live = { ...currentScalingOptions, desiredCount: 3 };
            const periodOverrides = { minDesired: 8 };
            const result = ScheduledScalingProcessor.mergeWithLiveDesired(base, live, periodOverrides);
            assert.strictEqual(result.desiredCount, 8);
        });

        test('period with desiredCount=0 is respected (not treated as unset)', () => {
            const base = { ...currentScalingOptions, desiredCount: 5 };
            const live = { ...currentScalingOptions, desiredCount: 12 };
            const periodOverrides = { minDesired: 0, maxDesired: 0, desiredCount: 0 };
            const result = ScheduledScalingProcessor.mergeWithLiveDesired(base, live, periodOverrides);
            assert.strictEqual(result.desiredCount, 0);
        });
    });

    describe('resolveTimezone', () => {
        test('uses explicit timezone when provided', () => {
            const config = { enabled: true, timezone: 'Asia/Tokyo', periods: [] };
            const result = ScheduledScalingProcessor.resolveTimezone(config, 'us-ashburn-1', 'UTC');
            assert.strictEqual(result, 'Asia/Tokyo');
        });

        test('falls back to region mapping', () => {
            const config = { enabled: true, periods: [] };
            const result = ScheduledScalingProcessor.resolveTimezone(config, 'us-ashburn-1', 'UTC');
            assert.strictEqual(result, 'America/New_York');
        });

        test('falls back to default timezone for unknown region', () => {
            const config = { enabled: true, periods: [] };
            const result = ScheduledScalingProcessor.resolveTimezone(config, 'unknown-region-1', 'UTC');
            assert.strictEqual(result, 'UTC');
        });
    });

    describe('scalingOptionsEqual', () => {
        test('returns true for identical options', () => {
            assert.strictEqual(
                ScheduledScalingProcessor.scalingOptionsEqual(currentScalingOptions, { ...currentScalingOptions }),
                true,
            );
        });

        test('returns false when a field differs', () => {
            assert.strictEqual(
                ScheduledScalingProcessor.scalingOptionsEqual(currentScalingOptions, {
                    ...currentScalingOptions,
                    desiredCount: 99,
                }),
                false,
            );
        });
    });

    describe('processScheduledScalingByGroup', () => {
        let context;
        const groupName = 'test-group';

        const alwaysPeakPeriod = {
            name: 'always-peak',
            dayOfWeek: [0, 1, 2, 3, 4, 5, 6],
            startHour: 0,
            endHour: 0,
            priority: 10,
            scalingOptions: { minDesired: 10, maxDesired: 20, desiredCount: 10 },
        };

        const instanceGroupManager = {
            getInstanceGroup: mock.fn(),
            upsertInstanceGroup: mock.fn(),
            setAutoScaleGracePeriod: mock.fn(),
        };

        const lockRelease = mock.fn();
        const lockManager = {
            lockGroup: mock.fn(() => ({ release: lockRelease })),
        };

        const audit = {
            saveAutoScalerActionItem: mock.fn(),
        };

        const processor = new ScheduledScalingProcessor({
            instanceGroupManager,
            lockManager,
            audit,
            defaultTimezone: 'UTC',
            enabled: true,
        });

        afterEach(() => {
            context = initContext();
            instanceGroupManager.getInstanceGroup.mock.resetCalls();
            instanceGroupManager.upsertInstanceGroup.mock.resetCalls();
            instanceGroupManager.setAutoScaleGracePeriod.mock.resetCalls();
            lockManager.lockGroup.mock.resetCalls();
            lockRelease.mock.resetCalls();
            audit.saveAutoScalerActionItem.mock.resetCalls();
        });

        test('skips when globally disabled', async () => {
            const disabledProcessor = new ScheduledScalingProcessor({
                instanceGroupManager,
                lockManager,
                audit,
                defaultTimezone: 'UTC',
                enabled: false,
            });
            context = initContext();
            const result = await disabledProcessor.processScheduledScalingByGroup(context, groupName);
            assert.strictEqual(result, false);
            assert.strictEqual(lockManager.lockGroup.mock.calls.length, 0);
        });

        test('skips when group has no scheduledScaling config', async () => {
            context = initContext();
            instanceGroupManager.getInstanceGroup.mock.mockImplementationOnce(() => ({
                name: groupName,
                region: 'us-ashburn-1',
                scalingOptions: { ...currentScalingOptions },
            }));
            const result = await processor.processScheduledScalingByGroup(context, groupName);
            assert.strictEqual(result, false);
            assert.strictEqual(lockRelease.mock.calls.length, 1);
        });

        test('skips when scheduledScaling.enabled is false', async () => {
            context = initContext();
            instanceGroupManager.getInstanceGroup.mock.mockImplementationOnce(() => ({
                name: groupName,
                region: 'us-ashburn-1',
                scalingOptions: { ...currentScalingOptions },
                scheduledScaling: { enabled: false, periods: [] },
            }));
            const result = await processor.processScheduledScalingByGroup(context, groupName);
            assert.strictEqual(result, false);
        });

        test('enters period: snapshots baseline and applies overrides', async () => {
            context = initContext();
            instanceGroupManager.getInstanceGroup.mock.mockImplementationOnce(() => ({
                name: groupName,
                region: 'us-ashburn-1',
                scalingOptions: { ...currentScalingOptions },
                scheduledScaling: {
                    enabled: true,
                    periods: [alwaysPeakPeriod],
                },
                // No scheduledScalingActivePeriod — first time entering a period
            }));

            const result = await processor.processScheduledScalingByGroup(context, groupName);
            assert.strictEqual(result, true);
            assert.strictEqual(instanceGroupManager.upsertInstanceGroup.mock.calls.length, 1);

            const updatedGroup = instanceGroupManager.upsertInstanceGroup.mock.calls[0].arguments[1];
            // Baseline should be snapshotted
            assert.deepStrictEqual(updatedGroup.scheduledScalingBaseOptions, currentScalingOptions);
            // Scaling options should reflect the period overrides
            assert.strictEqual(updatedGroup.scalingOptions.desiredCount, 10);
            assert.strictEqual(updatedGroup.scalingOptions.minDesired, 10);
            assert.strictEqual(updatedGroup.scalingOptions.maxDesired, 20);
            // Non-overridden values come from baseline
            assert.strictEqual(updatedGroup.scalingOptions.scaleUpQuantity, 1);
            assert.strictEqual(updatedGroup.scalingOptions.scalePeriod, 60);
            // Active period tracked
            assert.strictEqual(updatedGroup.scheduledScalingActivePeriod, 'always-peak');

            // Audit recorded
            assert.strictEqual(audit.saveAutoScalerActionItem.mock.calls.length, 1);
            const auditArgs = audit.saveAutoScalerActionItem.mock.calls[0].arguments;
            assert.strictEqual(auditArgs[1].actionType, 'scheduledScalingTransition');
            assert.strictEqual(auditArgs[1].oldDesiredCount, 2);
            assert.strictEqual(auditArgs[1].newDesiredCount, 10);
        });

        test('no-op when same period is still active (no boundary crossed)', async () => {
            context = initContext();
            instanceGroupManager.getInstanceGroup.mock.mockImplementationOnce(() => ({
                name: groupName,
                region: 'us-ashburn-1',
                scalingOptions: { ...currentScalingOptions, minDesired: 10, maxDesired: 20, desiredCount: 10 },
                scheduledScaling: {
                    enabled: true,
                    periods: [alwaysPeakPeriod],
                },
                scheduledScalingActivePeriod: 'always-peak',
                scheduledScalingBaseOptions: { ...currentScalingOptions },
            }));

            const result = await processor.processScheduledScalingByGroup(context, groupName);
            assert.strictEqual(result, false);
            assert.strictEqual(instanceGroupManager.upsertInstanceGroup.mock.calls.length, 0);
            assert.strictEqual(audit.saveAutoScalerActionItem.mock.calls.length, 0);
        });

        test('admin override preserved when same period still active', async () => {
            context = initContext();
            // Admin changed desiredCount to 50 while always-peak is active
            instanceGroupManager.getInstanceGroup.mock.mockImplementationOnce(() => ({
                name: groupName,
                region: 'us-ashburn-1',
                scalingOptions: { ...currentScalingOptions, minDesired: 10, maxDesired: 20, desiredCount: 50 },
                scheduledScaling: {
                    enabled: true,
                    periods: [alwaysPeakPeriod],
                },
                scheduledScalingActivePeriod: 'always-peak',
                scheduledScalingBaseOptions: { ...currentScalingOptions },
            }));

            const result = await processor.processScheduledScalingByGroup(context, groupName);
            // No boundary crossed, so processor does nothing — admin's 50 is preserved
            assert.strictEqual(result, false);
            assert.strictEqual(instanceGroupManager.upsertInstanceGroup.mock.calls.length, 0);
        });

        test('restores baseline when period ends', async () => {
            context = initContext();
            const baseOptions = { ...currentScalingOptions };
            instanceGroupManager.getInstanceGroup.mock.mockImplementationOnce(() => ({
                name: groupName,
                region: 'us-ashburn-1',
                scalingOptions: { ...currentScalingOptions, minDesired: 10, maxDesired: 20, desiredCount: 10 },
                scheduledScaling: {
                    enabled: true,
                    periods: [], // No periods match — simulates period ending
                },
                scheduledScalingActivePeriod: 'always-peak',
                scheduledScalingBaseOptions: baseOptions,
            }));

            const result = await processor.processScheduledScalingByGroup(context, groupName);
            assert.strictEqual(result, true);

            const updatedGroup = instanceGroupManager.upsertInstanceGroup.mock.calls[0].arguments[1];
            // Scaling options restored to baseline
            assert.strictEqual(updatedGroup.scalingOptions.desiredCount, baseOptions.desiredCount);
            assert.strictEqual(updatedGroup.scalingOptions.minDesired, baseOptions.minDesired);
            assert.strictEqual(updatedGroup.scalingOptions.maxDesired, baseOptions.maxDesired);
            // Tracking fields cleared
            assert.strictEqual(updatedGroup.scheduledScalingActivePeriod, undefined);
            assert.strictEqual(updatedGroup.scheduledScalingBaseOptions, undefined);
        });

        test('switches periods using baseOptions, not current options', async () => {
            context = initContext();
            const baseOptions = { ...currentScalingOptions };
            const periodB = {
                name: 'night',
                dayOfWeek: [0, 1, 2, 3, 4, 5, 6],
                startHour: 0,
                endHour: 0,
                priority: 20,
                scalingOptions: { minDesired: 0, maxDesired: 3, desiredCount: 1 },
            };
            instanceGroupManager.getInstanceGroup.mock.mockImplementationOnce(() => ({
                name: groupName,
                region: 'us-ashburn-1',
                // Current options reflect period-A (always-peak)
                scalingOptions: { ...currentScalingOptions, minDesired: 10, maxDesired: 20, desiredCount: 10 },
                scheduledScaling: {
                    enabled: true,
                    periods: [periodB], // Only period-B matches now
                },
                scheduledScalingActivePeriod: 'always-peak',
                scheduledScalingBaseOptions: baseOptions,
            }));

            const result = await processor.processScheduledScalingByGroup(context, groupName);
            assert.strictEqual(result, true);

            const updatedGroup = instanceGroupManager.upsertInstanceGroup.mock.calls[0].arguments[1];
            // Period-B overrides merged onto baseline, NOT onto period-A's values
            assert.strictEqual(updatedGroup.scalingOptions.desiredCount, 1);
            assert.strictEqual(updatedGroup.scalingOptions.minDesired, 0);
            assert.strictEqual(updatedGroup.scalingOptions.maxDesired, 3);
            // Non-overridden fields come from baseline
            assert.strictEqual(updatedGroup.scalingOptions.scaleUpQuantity, baseOptions.scaleUpQuantity);
            assert.strictEqual(updatedGroup.scalingOptions.scalePeriod, baseOptions.scalePeriod);
            // Active period updated, baseOptions preserved
            assert.strictEqual(updatedGroup.scheduledScalingActivePeriod, 'night');
            assert.deepStrictEqual(updatedGroup.scheduledScalingBaseOptions, baseOptions);
        });

        test('backward compat: bootstraps group with no tracking fields', async () => {
            context = initContext();
            instanceGroupManager.getInstanceGroup.mock.mockImplementationOnce(() => ({
                name: groupName,
                region: 'us-ashburn-1',
                scalingOptions: { ...currentScalingOptions },
                scheduledScaling: {
                    enabled: true,
                    periods: [alwaysPeakPeriod],
                },
                // No scheduledScalingActivePeriod or scheduledScalingBaseOptions
            }));

            const result = await processor.processScheduledScalingByGroup(context, groupName);
            assert.strictEqual(result, true);

            const updatedGroup = instanceGroupManager.upsertInstanceGroup.mock.calls[0].arguments[1];
            assert.deepStrictEqual(updatedGroup.scheduledScalingBaseOptions, currentScalingOptions);
            assert.strictEqual(updatedGroup.scheduledScalingActivePeriod, 'always-peak');
        });

        test('no-op when no period active and none was previously active', async () => {
            context = initContext();
            instanceGroupManager.getInstanceGroup.mock.mockImplementationOnce(() => ({
                name: groupName,
                region: 'us-ashburn-1',
                scalingOptions: { ...currentScalingOptions },
                scheduledScaling: {
                    enabled: true,
                    periods: [], // No periods match
                },
                // scheduledScalingActivePeriod is undefined
            }));

            const result = await processor.processScheduledScalingByGroup(context, groupName);
            assert.strictEqual(result, false);
            assert.strictEqual(instanceGroupManager.upsertInstanceGroup.mock.calls.length, 0);
        });

        test('releases lock even when getInstanceGroup returns null', async () => {
            context = initContext();
            instanceGroupManager.getInstanceGroup.mock.mockImplementationOnce(() => null);
            const result = await processor.processScheduledScalingByGroup(context, groupName);
            assert.strictEqual(result, false);
            assert.strictEqual(lockRelease.mock.calls.length, 1);
        });

        test('logs warning when period resolves to desiredCount=0', async () => {
            context = initContext();
            const zeroScalePeriod = {
                name: 'scale-to-zero',
                dayOfWeek: [0, 1, 2, 3, 4, 5, 6],
                startHour: 0,
                endHour: 0,
                priority: 10,
                scalingOptions: { minDesired: 0, maxDesired: 0, desiredCount: 0 },
            };
            instanceGroupManager.getInstanceGroup.mock.mockImplementationOnce(() => ({
                name: groupName,
                region: 'us-ashburn-1',
                scalingOptions: { ...currentScalingOptions },
                scheduledScaling: {
                    enabled: true,
                    periods: [zeroScalePeriod],
                },
            }));

            const result = await processor.processScheduledScalingByGroup(context, groupName);
            assert.strictEqual(result, true);

            const warnCalls = context.logger.warn.mock.calls;
            const zeroWarning = warnCalls.find((call) => call.arguments[0].includes('desiredCount=0'));
            assert.ok(zeroWarning, 'Expected a warning log about desiredCount=0');
        });

        test('returns false and does not call audit on lock failure', async () => {
            context = initContext();
            const lockFailProcessor = new ScheduledScalingProcessor({
                instanceGroupManager,
                lockManager: {
                    lockGroup: mock.fn(() => {
                        throw new Error('lock failed');
                    }),
                },
                audit,
                defaultTimezone: 'UTC',
                enabled: true,
            });
            const result = await lockFailProcessor.processScheduledScalingByGroup(context, groupName);
            assert.strictEqual(result, false);
            assert.strictEqual(audit.saveAutoScalerActionItem.mock.calls.length, 0);
        });
    });
});
