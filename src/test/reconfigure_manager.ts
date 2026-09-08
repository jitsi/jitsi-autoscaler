/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck

import assert from 'node:assert';
import test, { beforeEach, describe, mock } from 'node:test';

import ReconfigureManager from '../reconfigure_manager';

describe('ReconfigureManager', () => {
    const context = {
        logger: {
            info: mock.fn(),
            debug: mock.fn(),
            error: mock.fn(),
            warn: mock.fn(),
        },
    };

    const group = 'group';
    const reconfigureTTL = 900;
    const instanceDetails = [
        { instanceId: 'i-1', instanceType: 'JVB', group },
        { instanceId: 'i-2', instanceType: 'JVB', group },
    ];

    let instanceStore;
    let audit;
    let manager;

    beforeEach(() => {
        context.logger.debug.mock.resetCalls();
        instanceStore = {
            setReconfigureDate: mock.fn(() => Promise.resolve(true)),
            unsetReconfigureDate: mock.fn(() => Promise.resolve(true)),
            getReconfigureDates: mock.fn((_ctx, _group, instanceIds) =>
                Promise.resolve(instanceIds.map((id) => (id === 'i-2' ? '2026-09-08T10:00:00.000Z' : ''))),
            ),
            getReconfigureDate: mock.fn(() => Promise.resolve('2026-09-08T10:00:00.000Z')),
        };
        audit = {
            saveReconfigureEvents: mock.fn(() => Promise.resolve()),
            saveUnsetReconfigureEvents: mock.fn(() => Promise.resolve()),
        };
        manager = new ReconfigureManager({ instanceStore, reconfigureTTL, audit });
    });

    describe('setReconfigureDate', () => {
        test('stores a fresh ISO date for every instance with the configured ttl and audits the request', async () => {
            const before = Date.now();
            const result = await manager.setReconfigureDate(context, instanceDetails);
            const after = Date.now();

            assert.strictEqual(result, true);
            assert.strictEqual(instanceStore.setReconfigureDate.mock.callCount(), 1);
            const [ctx, details, date, ttl] = instanceStore.setReconfigureDate.mock.calls[0].arguments;
            assert.strictEqual(ctx, context);
            assert.strictEqual(details, instanceDetails);
            assert.strictEqual(ttl, reconfigureTTL);
            // The date is the wall clock at the time of the call, serialised as ISO-8601.
            assert.strictEqual(new Date(date).toISOString(), date);
            const parsed = new Date(date).getTime();
            assert.ok(parsed >= before && parsed <= after, `expected ${date} to fall within the call window`);

            assert.strictEqual(audit.saveReconfigureEvents.mock.callCount(), 1);
            assert.strictEqual(audit.saveReconfigureEvents.mock.calls[0].arguments[0], instanceDetails);
        });

        test('propagates a negative result from the store', async () => {
            instanceStore.setReconfigureDate = mock.fn(() => Promise.resolve(false));
            manager = new ReconfigureManager({ instanceStore, reconfigureTTL, audit });

            assert.strictEqual(await manager.setReconfigureDate(context, instanceDetails), false);
        });

        test('bulk path passes an empty list through untouched', async () => {
            assert.strictEqual(await manager.setReconfigureDate(context, []), true);
            assert.deepStrictEqual(instanceStore.setReconfigureDate.mock.calls[0].arguments[1], []);
            assert.deepStrictEqual(audit.saveReconfigureEvents.mock.calls[0].arguments[0], []);
        });
    });

    describe('unsetReconfigureDate', () => {
        test('clears the date for a single instance and audits completion', async () => {
            const result = await manager.unsetReconfigureDate(context, 'i-1', group);

            assert.strictEqual(result, true);
            assert.deepStrictEqual(instanceStore.unsetReconfigureDate.mock.calls[0].arguments, [context, 'i-1', group]);
            assert.deepStrictEqual(audit.saveUnsetReconfigureEvents.mock.calls[0].arguments, ['i-1', group]);
        });

        test('propagates a negative result from the store', async () => {
            instanceStore.unsetReconfigureDate = mock.fn(() => Promise.resolve(false));
            manager = new ReconfigureManager({ instanceStore, reconfigureTTL, audit });

            assert.strictEqual(await manager.unsetReconfigureDate(context, 'i-1', group), false);
        });
    });

    describe('getReconfigureDates / getReconfigureDate', () => {
        test('bulk read returns the store result positionally for the requested ids', async () => {
            const dates = await manager.getReconfigureDates(context, group, ['i-1', 'i-2', 'i-3']);

            assert.deepStrictEqual(dates, ['', '2026-09-08T10:00:00.000Z', '']);
            assert.deepStrictEqual(instanceStore.getReconfigureDates.mock.calls[0].arguments, [
                context,
                group,
                ['i-1', 'i-2', 'i-3'],
            ]);
        });

        test('bulk read of no ids returns an empty list', async () => {
            assert.deepStrictEqual(await manager.getReconfigureDates(context, group, []), []);
        });

        test('single read passes group and instance id through to the store', async () => {
            const date = await manager.getReconfigureDate(context, group, 'i-2');

            assert.strictEqual(date, '2026-09-08T10:00:00.000Z');
            assert.deepStrictEqual(instanceStore.getReconfigureDate.mock.calls[0].arguments, [context, group, 'i-2']);
        });
    });

    describe('processInstanceReport', () => {
        const scheduled = '2026-09-08T10:00:00.000Z';
        const report = (reconfigureComplete) => ({
            instance: { instanceId: 'i-1', instanceType: 'JVB', group },
            reconfigureComplete,
        });

        test('returns the scheduled date unchanged when the sidecar has not reported completion', async () => {
            const result = await manager.processInstanceReport(context, report(undefined), scheduled);

            assert.strictEqual(result, scheduled);
            assert.strictEqual(instanceStore.unsetReconfigureDate.mock.callCount(), 0);
            assert.strictEqual(audit.saveUnsetReconfigureEvents.mock.callCount(), 0);
        });

        test('returns the scheduled date unchanged when the last completion predates the schedule', async () => {
            const result = await manager.processInstanceReport(context, report('2026-09-08T09:59:59.000Z'), scheduled);

            assert.strictEqual(result, scheduled);
            assert.strictEqual(instanceStore.unsetReconfigureDate.mock.callCount(), 0);
        });

        test('unsets the schedule and returns an empty date when completion is at or after the schedule', async () => {
            const atSchedule = await manager.processInstanceReport(context, report(scheduled), scheduled);
            assert.strictEqual(atSchedule, '');

            const afterSchedule = await manager.processInstanceReport(
                context,
                report('2026-09-08T10:00:01.000Z'),
                scheduled,
            );
            assert.strictEqual(afterSchedule, '');

            assert.strictEqual(instanceStore.unsetReconfigureDate.mock.callCount(), 2);
            assert.deepStrictEqual(instanceStore.unsetReconfigureDate.mock.calls[0].arguments, [context, 'i-1', group]);
            assert.strictEqual(audit.saveUnsetReconfigureEvents.mock.callCount(), 2);
            assert.deepStrictEqual(audit.saveUnsetReconfigureEvents.mock.calls[0].arguments, ['i-1', group]);
            assert.ok(context.logger.debug.mock.callCount() >= 2);
        });

        test('does nothing when no reconfiguration is scheduled, even if the sidecar reports a completion', async () => {
            const result = await manager.processInstanceReport(context, report('2026-09-08T12:00:00.000Z'), '');

            assert.strictEqual(result, '');
            assert.strictEqual(instanceStore.unsetReconfigureDate.mock.callCount(), 0);
        });
    });
});
