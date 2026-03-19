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

const baseScalingOptions = {
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
        });

        test('converts UTC time to Tokyo timezone', () => {
            // 2026-03-18 18:00 UTC = 2026-03-19 03:00 JST (next day, Thursday)
            const now = new Date('2026-03-18T18:00:00Z');
            const result = ScheduledScalingProcessor.getLocalTime(now, 'Asia/Tokyo');
            assert.strictEqual(result.dayOfWeek, 4); // Thursday
            assert.strictEqual(result.hour, 3);
        });

        test('handles day boundary crossing for Sydney', () => {
            // 2026-03-20 (Friday) 15:00 UTC = 2026-03-21 (Saturday) 02:00 AEDT
            const now = new Date('2026-03-20T15:00:00Z');
            const result = ScheduledScalingProcessor.getLocalTime(now, 'Australia/Sydney');
            assert.strictEqual(result.dayOfWeek, 6); // Saturday
            assert.strictEqual(result.hour, 2);
        });
    });

    describe('isHourInRange', () => {
        test('normal range (8-20): hour inside', () => {
            assert.strictEqual(ScheduledScalingProcessor.isHourInRange(12, 8, 20), true);
        });

        test('normal range (8-20): hour at start', () => {
            assert.strictEqual(ScheduledScalingProcessor.isHourInRange(8, 8, 20), true);
        });

        test('normal range (8-20): hour at end (exclusive)', () => {
            assert.strictEqual(ScheduledScalingProcessor.isHourInRange(20, 8, 20), false);
        });

        test('normal range (8-20): hour outside', () => {
            assert.strictEqual(ScheduledScalingProcessor.isHourInRange(6, 8, 20), false);
        });

        test('midnight wrap (22-6): hour before midnight', () => {
            assert.strictEqual(ScheduledScalingProcessor.isHourInRange(23, 22, 6), true);
        });

        test('midnight wrap (22-6): hour after midnight', () => {
            assert.strictEqual(ScheduledScalingProcessor.isHourInRange(3, 22, 6), true);
        });

        test('midnight wrap (22-6): hour outside', () => {
            assert.strictEqual(ScheduledScalingProcessor.isHourInRange(12, 22, 6), false);
        });

        test('all-day (0-0): matches any hour', () => {
            assert.strictEqual(ScheduledScalingProcessor.isHourInRange(0, 0, 0), true);
            assert.strictEqual(ScheduledScalingProcessor.isHourInRange(12, 0, 0), true);
            assert.strictEqual(ScheduledScalingProcessor.isHourInRange(23, 0, 0), true);
        });
    });

    describe('findActivePeriod', () => {
        const config = {
            enabled: true,
            baseScalingOptions,
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
            const emptyConfig = { enabled: true, baseScalingOptions, periods: [] };
            const now = new Date('2026-03-18T18:00:00Z');
            const result = ScheduledScalingProcessor.findActivePeriod(emptyConfig, now, 'America/New_York');
            assert.strictEqual(result, null);
        });

        test('higher priority wins when periods overlap', () => {
            // Create a config where both periods match on Saturday peak hours
            const overlappingConfig = {
                enabled: true,
                baseScalingOptions,
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
    });

    describe('resolveActiveScalingOptions', () => {
        const config = {
            enabled: true,
            baseScalingOptions,
            periods: [peakPeriod, weekendPeriod],
        };

        test('returns peak options during weekday peak hours', () => {
            const now = new Date('2026-03-18T18:00:00Z'); // Wednesday 14:00 ET
            const result = ScheduledScalingProcessor.resolveActiveScalingOptions(config, now, 'America/New_York');
            assert.strictEqual(result.minDesired, 10);
            assert.strictEqual(result.maxDesired, 20);
            assert.strictEqual(result.desiredCount, 10);
            // Non-overridden values should come from base
            assert.strictEqual(result.scaleUpQuantity, 1);
            assert.strictEqual(result.scalePeriod, 60);
        });

        test('returns base options during weekday off-peak', () => {
            const now = new Date('2026-03-19T03:00:00Z'); // Wednesday 22:00 ET
            const result = ScheduledScalingProcessor.resolveActiveScalingOptions(config, now, 'America/New_York');
            assert.strictEqual(result.minDesired, 1);
            assert.strictEqual(result.maxDesired, 5);
            assert.strictEqual(result.desiredCount, 2);
        });

        test('returns weekend options on Saturday', () => {
            const now = new Date('2026-03-21T16:00:00Z'); // Saturday 12:00 ET
            const result = ScheduledScalingProcessor.resolveActiveScalingOptions(config, now, 'America/New_York');
            assert.strictEqual(result.minDesired, 0);
            assert.strictEqual(result.maxDesired, 2);
            assert.strictEqual(result.desiredCount, 1);
        });

        test('enforces minDesired <= desiredCount', () => {
            const badConfig = {
                enabled: true,
                baseScalingOptions: { ...baseScalingOptions },
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
            const result = ScheduledScalingProcessor.resolveActiveScalingOptions(badConfig, now, 'America/New_York');
            assert.ok(result.desiredCount >= result.minDesired);
        });

        test('enforces maxDesired >= desiredCount', () => {
            const badConfig = {
                enabled: true,
                baseScalingOptions: { ...baseScalingOptions },
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
            const result = ScheduledScalingProcessor.resolveActiveScalingOptions(badConfig, now, 'America/New_York');
            assert.ok(result.maxDesired >= result.desiredCount);
        });
    });

    describe('resolveTimezone', () => {
        test('uses explicit timezone when provided', () => {
            const config = { enabled: true, timezone: 'Asia/Tokyo', baseScalingOptions, periods: [] };
            const result = ScheduledScalingProcessor.resolveTimezone(config, 'us-ashburn-1', 'UTC');
            assert.strictEqual(result, 'Asia/Tokyo');
        });

        test('falls back to region mapping', () => {
            const config = { enabled: true, baseScalingOptions, periods: [] };
            const result = ScheduledScalingProcessor.resolveTimezone(config, 'us-ashburn-1', 'UTC');
            assert.strictEqual(result, 'America/New_York');
        });

        test('falls back to default timezone for unknown region', () => {
            const config = { enabled: true, baseScalingOptions, periods: [] };
            const result = ScheduledScalingProcessor.resolveTimezone(config, 'unknown-region-1', 'UTC');
            assert.strictEqual(result, 'UTC');
        });
    });

    describe('scalingOptionsEqual', () => {
        test('returns true for identical options', () => {
            assert.strictEqual(
                ScheduledScalingProcessor.scalingOptionsEqual(baseScalingOptions, { ...baseScalingOptions }),
                true,
            );
        });

        test('returns false when a field differs', () => {
            assert.strictEqual(
                ScheduledScalingProcessor.scalingOptionsEqual(baseScalingOptions, {
                    ...baseScalingOptions,
                    desiredCount: 99,
                }),
                false,
            );
        });
    });

    describe('processScheduledScalingByGroup', () => {
        let context;
        const groupName = 'test-group';

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
                scalingOptions: { ...baseScalingOptions },
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
                scalingOptions: { ...baseScalingOptions },
                scheduledScaling: { enabled: false, baseScalingOptions, periods: [] },
            }));
            const result = await processor.processScheduledScalingByGroup(context, groupName);
            assert.strictEqual(result, false);
        });

        test('updates scaling options when they differ from target', async () => {
            context = initContext();
            instanceGroupManager.getInstanceGroup.mock.mockImplementationOnce(() => ({
                name: groupName,
                region: 'us-ashburn-1',
                enableScheduler: true,
                scalingOptions: { ...baseScalingOptions },
                scheduledScaling: {
                    enabled: true,
                    baseScalingOptions,
                    periods: [
                        {
                            name: 'always-peak',
                            dayOfWeek: [0, 1, 2, 3, 4, 5, 6],
                            startHour: 0,
                            endHour: 0,
                            priority: 10,
                            scalingOptions: { minDesired: 10, maxDesired: 20, desiredCount: 10 },
                        },
                    ],
                },
            }));

            const result = await processor.processScheduledScalingByGroup(context, groupName);
            assert.strictEqual(result, true);
            assert.strictEqual(instanceGroupManager.upsertInstanceGroup.mock.calls.length, 1);
            assert.strictEqual(instanceGroupManager.setAutoScaleGracePeriod.mock.calls.length, 1);

            const updatedGroup = instanceGroupManager.upsertInstanceGroup.mock.calls[0].arguments[1];
            assert.strictEqual(updatedGroup.scalingOptions.desiredCount, 10);
            assert.strictEqual(updatedGroup.scalingOptions.minDesired, 10);
            assert.strictEqual(updatedGroup.scalingOptions.maxDesired, 20);
            // enableScheduler should be disabled
            assert.strictEqual(updatedGroup.enableScheduler, false);

            // Audit should record the transition
            assert.strictEqual(audit.saveAutoScalerActionItem.mock.calls.length, 1);
            const auditArgs = audit.saveAutoScalerActionItem.mock.calls[0].arguments;
            assert.strictEqual(auditArgs[0], groupName);
            assert.strictEqual(auditArgs[1].actionType, 'scheduledScalingTransition');
            assert.strictEqual(auditArgs[1].oldDesiredCount, 2);
            assert.strictEqual(auditArgs[1].newDesiredCount, 10);
        });

        test('skips update when options already match (idempotent)', async () => {
            context = initContext();
            // Group already has the target options
            instanceGroupManager.getInstanceGroup.mock.mockImplementationOnce(() => ({
                name: groupName,
                region: 'us-ashburn-1',
                scalingOptions: { ...baseScalingOptions },
                scheduledScaling: {
                    enabled: true,
                    baseScalingOptions,
                    periods: [], // No active period, so target = base = current
                },
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

        test('does not call audit when no changes needed', async () => {
            context = initContext();
            instanceGroupManager.getInstanceGroup.mock.mockImplementationOnce(() => ({
                name: groupName,
                region: 'us-ashburn-1',
                scalingOptions: { ...baseScalingOptions },
                scheduledScaling: {
                    enabled: true,
                    baseScalingOptions,
                    periods: [],
                },
            }));

            const result = await processor.processScheduledScalingByGroup(context, groupName);
            assert.strictEqual(result, false);
            assert.strictEqual(audit.saveAutoScalerActionItem.mock.calls.length, 0);
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
