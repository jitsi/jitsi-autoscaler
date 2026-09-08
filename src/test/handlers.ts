/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck

import assert from 'node:assert';
import { ReservationNotExtendableError } from '../reservation_manager';
import test, { describe, mock } from 'node:test';

import Handlers from '../handlers';
import { ReservationStatus } from '../reservation';

describe('Handlers', () => {
    const context = {
        logger: {
            info: mock.fn(),
            debug: mock.fn(),
            error: mock.fn(),
            warn: mock.fn(),
        },
    };

    // Build a fresh Handlers instance with isolated mocks for each test so call
    // counts never leak across tests.
    function makeHarness(groupOverrides = {}, reservationOverrides = {}, extraOptions = {}) {
        const group = {
            name: 'grid-group',
            type: 'selenium-grid',
            enableAutoScale: true,
            scalingOptions: {
                minDesired: 0,
                maxDesired: 10,
                desiredCount: 0,
                reservationScaleUpThreshold: 1,
            },
            ...groupOverrides,
        };

        const lock = { release: mock.fn(() => Promise.resolve()) };
        const lockManager = { lockGroup: mock.fn(() => Promise.resolve(lock)) };

        // Records the order in which group-manager mutations happen so tests can assert ordering.
        const callOrder = [];
        const instanceGroupManager = {
            getInstanceGroup: mock.fn(() => Promise.resolve(group)),
            upsertInstanceGroup: mock.fn(() => {
                callOrder.push('upsertInstanceGroup');
                return Promise.resolve();
            }),
            setAutoScaleGracePeriod: mock.fn(() => Promise.resolve()),
            setScaleDownProtected: mock.fn(() => {
                callOrder.push('setScaleDownProtected');
                return Promise.resolve();
            }),
            deleteInstanceGroup: mock.fn(() => Promise.resolve()),
        };

        const reservation = {
            id: 'res-1',
            groupName: group.name,
            nodeCount: 3,
            status: ReservationStatus.Active,
            createdAt: Date.now(),
            expiresAt: Date.now() + 3600 * 1000,
            ...reservationOverrides,
        };

        const reservationManager = {
            createReservation: mock.fn(() => Promise.resolve(reservation)),
            cancelReservation: mock.fn(() => Promise.resolve(reservation)),
            getReservation: mock.fn(() => Promise.resolve(reservation)),
            getQueuePosition: mock.fn(() => Promise.resolve(null)),
            getActiveReservedNodeCount: mock.fn(() => Promise.resolve(reservation.nodeCount)),
            promotePendingReservations: mock.fn(() => Promise.resolve([])),
            extendReservation: mock.fn(() => Promise.resolve(reservation)),
        };

        const handlers = new Handlers({
            lockManager,
            instanceGroupManager,
            reservationManager,
            defaultTimezone: 'UTC',
            ...extraOptions,
        });

        return {
            handlers,
            group,
            lock,
            lockManager,
            instanceGroupManager,
            reservationManager,
            reservation,
            callOrder,
        };
    }

    function mockReq(overrides = {}) {
        return { context, params: { name: 'grid-group' }, body: {}, query: {}, ...overrides };
    }

    function mockRes() {
        return {
            statusCode: undefined,
            body: undefined,
            status(code) {
                this.statusCode = code;
                return this;
            },
            send(body) {
                this.body = body;
                return this;
            },
            sendStatus(code) {
                this.statusCode = code;
                return this;
            },
        };
    }

    describe('createReservation', () => {
        test('records the reservation but does not drive desiredCount when autoscaling is off', async () => {
            const h = makeHarness({ enableAutoScale: false });
            const req = mockReq({ body: { nodeCount: 3 } });
            const res = mockRes();

            await h.handlers.createReservation(req, res);

            // Reservation is taken and held.
            assert.strictEqual(res.statusCode, 201);
            assert.strictEqual(res.body.reservation.id, 'res-1');
            assert.strictEqual(h.reservationManager.createReservation.mock.calls.length, 1);
            // But the held reservation must not change the group's desired count.
            assert.strictEqual(h.instanceGroupManager.upsertInstanceGroup.mock.calls.length, 0);
            assert.strictEqual(h.reservationManager.getActiveReservedNodeCount.mock.calls.length, 0);
            assert.strictEqual(h.lock.release.mock.calls.length, 1);
        });

        test('bumps desiredCount for an active reservation when autoscaling is on', async () => {
            const h = makeHarness({ enableAutoScale: true });
            const req = mockReq({ body: { nodeCount: 3 } });
            const res = mockRes();

            await h.handlers.createReservation(req, res);

            assert.strictEqual(res.statusCode, 201);
            // reserved (3) - desiredCount (0) = 3 >= threshold (1) -> desiredCount is raised.
            assert.strictEqual(h.reservationManager.getActiveReservedNodeCount.mock.calls.length, 1);
            assert.strictEqual(h.instanceGroupManager.upsertInstanceGroup.mock.calls.length, 1);
            assert.strictEqual(h.group.scalingOptions.desiredCount, 3);
        });
    });

    describe('deleteReservation', () => {
        test('does not promote or recalculate desiredCount when autoscaling is off', async () => {
            const h = makeHarness({ enableAutoScale: false });
            const req = mockReq({ params: { name: 'grid-group', id: 'res-1' } });
            const res = mockRes();

            await h.handlers.deleteReservation(req, res);

            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(h.reservationManager.cancelReservation.mock.calls.length, 1);
            // Held mode: capacity is released but promotion/recalc are deferred to the autoscaler.
            assert.strictEqual(h.reservationManager.promotePendingReservations.mock.calls.length, 0);
            assert.strictEqual(h.instanceGroupManager.upsertInstanceGroup.mock.calls.length, 0);
            assert.strictEqual(h.lock.release.mock.calls.length, 1);
        });

        test('promotes pending reservations when autoscaling is on', async () => {
            const h = makeHarness({ enableAutoScale: true });
            const req = mockReq({ params: { name: 'grid-group', id: 'res-1' } });
            const res = mockRes();

            await h.handlers.deleteReservation(req, res);

            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(h.reservationManager.promotePendingReservations.mock.calls.length, 1);
        });
    });

    describe('extendReservation', () => {
        test('acquires the group lock and passes the group name to the manager', async () => {
            const h = makeHarness();
            const req = mockReq({ params: { name: 'grid-group', id: 'res-1' }, body: { ttlSeconds: 600 } });
            const res = mockRes();

            await h.handlers.extendReservation(req, res);

            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(h.lockManager.lockGroup.mock.calls.length, 1);
            assert.strictEqual(h.lockManager.lockGroup.mock.calls[0].arguments[1], 'grid-group');
            assert.strictEqual(h.lock.release.mock.calls.length, 1);
            const args = h.reservationManager.extendReservation.mock.calls[0].arguments;
            assert.strictEqual(args[1], 'grid-group');
            assert.strictEqual(args[2], 'res-1');
            assert.strictEqual(args[3], 600);
        });

        test('returns 404 when the manager rejects the reservation and still releases the lock', async () => {
            const h = makeHarness();
            h.reservationManager.extendReservation.mock.mockImplementationOnce(() => Promise.resolve(null));
            const req = mockReq({ params: { name: 'grid-group', id: 'res-9' }, body: { ttlSeconds: 600 } });
            const res = mockRes();

            await h.handlers.extendReservation(req, res);

            assert.strictEqual(res.statusCode, 404);
            assert.strictEqual(h.lock.release.mock.calls.length, 1);
        });

        test('returns 409 when the reservation is already terminal and still releases the lock', async () => {
            const h = makeHarness();
            const terminal = { id: 'res-2', groupName: 'grid-group', status: 'expired' };
            h.reservationManager.extendReservation.mock.mockImplementationOnce(() =>
                Promise.reject(new ReservationNotExtendableError(terminal)),
            );
            const req = mockReq({ params: { name: 'grid-group', id: 'res-2' }, body: { ttlSeconds: 600 } });
            const res = mockRes();

            await h.handlers.extendReservation(req, res);

            assert.strictEqual(res.statusCode, 409);
            assert.strictEqual(h.lock.release.mock.calls.length, 1);
        });
    });

    describe('updateScheduledScaling', () => {
        const baseOptions = {
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
        // Period without an explicit desiredCount, active all day every day.
        const peakNoDesired = {
            name: 'peak',
            dayOfWeek: [0, 1, 2, 3, 4, 5, 6],
            startHour: 0,
            endHour: 0,
            priority: 10,
            scalingOptions: { minDesired: 3, maxDesired: 20 },
        };

        test('edited mid-period to a config with no active period restores baseline, preserving live desiredCount when the removed period did not set it', async () => {
            const h = makeHarness({
                region: 'us-ashburn-1',
                // autoscaler moved desiredCount to 7 while "peak" was active
                scalingOptions: { ...baseOptions, minDesired: 3, maxDesired: 20, desiredCount: 7 },
                scheduledScaling: { enabled: true, periods: [peakNoDesired] },
                scheduledScalingActivePeriod: 'peak',
                scheduledScalingBaseOptions: { ...baseOptions },
            });
            const req = mockReq({ body: { enabled: true, periods: [] } });
            const res = mockRes();

            await h.handlers.updateScheduledScaling(req, res);

            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(h.instanceGroupManager.upsertInstanceGroup.mock.calls.length, 1);
            const saved = h.instanceGroupManager.upsertInstanceGroup.mock.calls[0].arguments[1];
            // baseline restored (min back to 1) but live desiredCount kept; invariants raise max to 7
            assert.strictEqual(saved.scalingOptions.minDesired, 1);
            assert.strictEqual(saved.scalingOptions.desiredCount, 7);
            assert.strictEqual(saved.scalingOptions.maxDesired, 7);
            assert.strictEqual(saved.scalingOptions.scalePeriod, 60);
            assert.strictEqual(saved.scheduledScalingActivePeriod, undefined);
            assert.strictEqual(saved.scheduledScalingBaseOptions, undefined);
            assert.deepStrictEqual(saved.scheduledScaling, { enabled: true, periods: [] });
            assert.strictEqual(h.lock.release.mock.calls.length, 1);
        });

        test('edited mid-period to a config with no active period restores baseline desiredCount when the removed period set it', async () => {
            const peakWithDesired = {
                ...peakNoDesired,
                scalingOptions: { minDesired: 3, maxDesired: 20, desiredCount: 10 },
            };
            const h = makeHarness({
                region: 'us-ashburn-1',
                scalingOptions: { ...baseOptions, minDesired: 3, maxDesired: 20, desiredCount: 10 },
                scheduledScaling: { enabled: true, periods: [peakWithDesired] },
                scheduledScalingActivePeriod: 'peak',
                scheduledScalingBaseOptions: { ...baseOptions },
            });
            const req = mockReq({ body: { enabled: true, periods: [] } });
            const res = mockRes();

            await h.handlers.updateScheduledScaling(req, res);

            const saved = h.instanceGroupManager.upsertInstanceGroup.mock.calls[0].arguments[1];
            assert.deepStrictEqual(saved.scalingOptions, baseOptions);
        });

        test('disabling mid-period restores baseline using the previous config', async () => {
            const h = makeHarness({
                region: 'us-ashburn-1',
                scalingOptions: { ...baseOptions, minDesired: 3, maxDesired: 20, desiredCount: 7 },
                scheduledScaling: { enabled: true, periods: [peakNoDesired] },
                scheduledScalingActivePeriod: 'peak',
                scheduledScalingBaseOptions: { ...baseOptions },
            });
            const req = mockReq({ body: { enabled: false, periods: [] } });
            const res = mockRes();

            await h.handlers.updateScheduledScaling(req, res);

            assert.strictEqual(res.statusCode, 200);
            const saved = h.instanceGroupManager.upsertInstanceGroup.mock.calls[0].arguments[1];
            assert.strictEqual(saved.scalingOptions.desiredCount, 7);
            assert.strictEqual(saved.scalingOptions.minDesired, 1);
            assert.strictEqual(saved.scheduledScalingActivePeriod, undefined);
            assert.strictEqual(saved.scheduledScalingBaseOptions, undefined);
        });
    });

    describe('launchProtectedInstanceGroup', () => {
        test('rejects with 400 under the lock when count would exceed maxDesired', async () => {
            const h = makeHarness({
                protectedTTLSec: 900,
                scalingOptions: { minDesired: 0, maxDesired: 10, desiredCount: 8 },
            });
            const req = mockReq({ body: { count: 3 } });
            const res = mockRes();

            await h.handlers.launchProtectedInstanceGroup(req, res);

            assert.strictEqual(res.statusCode, 400);
            assert.strictEqual(h.instanceGroupManager.upsertInstanceGroup.mock.calls.length, 0);
            assert.strictEqual(h.instanceGroupManager.setScaleDownProtected.mock.calls.length, 0);
            assert.strictEqual(h.lock.release.mock.calls.length, 1);
        });

        test('rejects with 400 when protectedTTLSec is not a positive integer', async () => {
            const h = makeHarness({
                protectedTTLSec: 900,
                scalingOptions: { minDesired: 0, maxDesired: 10, desiredCount: 0 },
            });
            const req = mockReq({ body: { count: 1, protectedTTLSec: 0 } });
            const res = mockRes();

            await h.handlers.launchProtectedInstanceGroup(req, res);

            assert.strictEqual(res.statusCode, 400);
            assert.strictEqual(h.instanceGroupManager.upsertInstanceGroup.mock.calls.length, 0);
        });

        test('applies protectedTTLSec and marks protection before persisting the raised desired count', async () => {
            const h = makeHarness({
                protectedTTLSec: 900,
                scalingOptions: { minDesired: 0, maxDesired: 10, desiredCount: 2 },
            });
            const req = mockReq({ body: { count: 3, protectedTTLSec: 1200, tags: { owner: 'qa' } } });
            const res = mockRes();

            await h.handlers.launchProtectedInstanceGroup(req, res);

            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(h.group.scalingOptions.desiredCount, 5);
            assert.strictEqual(h.group.protectedTTLSec, 1200);
            assert.strictEqual(h.group.tags.owner, 'qa');
            assert.deepStrictEqual(h.callOrder, ['setScaleDownProtected', 'upsertInstanceGroup']);
            assert.strictEqual(h.lock.release.mock.calls.length, 1);
        });

        test('uses the new maxDesired from the request when checking capacity', async () => {
            const h = makeHarness({
                protectedTTLSec: 900,
                scalingOptions: { minDesired: 0, maxDesired: 10, desiredCount: 8 },
            });
            const req = mockReq({ body: { count: 3, maxDesired: 20 } });
            const res = mockRes();

            await h.handlers.launchProtectedInstanceGroup(req, res);

            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(h.group.scalingOptions.maxDesired, 20);
            assert.strictEqual(h.group.scalingOptions.desiredCount, 11);
            // falls back to the group's own protectedTTLSec
            assert.strictEqual(h.group.protectedTTLSec, 900);
        });
    });

    describe('deleteInstanceGroup', () => {
        test('returns 409 under the lock when the group has active instances', async () => {
            const validator = { groupHasActiveInstances: mock.fn(() => Promise.resolve(true)) };
            const h = makeHarness({}, {}, { validator });
            const req = mockReq();
            const res = mockRes();

            await h.handlers.deleteInstanceGroup(req, res);

            assert.strictEqual(res.statusCode, 409);
            assert.strictEqual(h.lockManager.lockGroup.mock.calls.length, 1);
            assert.strictEqual(validator.groupHasActiveInstances.mock.calls[0].arguments[0], context);
            assert.strictEqual(h.instanceGroupManager.deleteInstanceGroup.mock.calls.length, 0);
            assert.strictEqual(h.lock.release.mock.calls.length, 1);
        });

        test('deletes the group when no instances are active', async () => {
            const validator = { groupHasActiveInstances: mock.fn(() => Promise.resolve(false)) };
            const h = makeHarness({}, {}, { validator });
            const req = mockReq();
            const res = mockRes();

            await h.handlers.deleteInstanceGroup(req, res);

            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(h.instanceGroupManager.deleteInstanceGroup.mock.calls.length, 1);
        });
    });

    describe('sidecar handlers', () => {
        function sidecarHarness() {
            const shutdownManager = { getShutdownStatus: mock.fn(() => Promise.resolve(false)) };
            const reconfigureManager = {
                getReconfigureDate: mock.fn(() => Promise.resolve('')),
                processInstanceReport: mock.fn(() => Promise.resolve('')),
            };
            const instanceTracker = { stats: mock.fn(() => Promise.resolve(true)) };
            const cloudManager = { shutdownInstance: mock.fn(() => Promise.resolve()) };
            const h = makeHarness({}, {}, { shutdownManager, reconfigureManager, instanceTracker, cloudManager });
            return { ...h, shutdownManager, reconfigureManager, instanceTracker, cloudManager };
        }

        const details = { instanceId: 'i-1', group: 'grid-group' };
        const statsBody = { instance: details, stats: {}, timestamp: Date.now() };

        test('poll returns 400 when instanceId or group is missing', async () => {
            const h = sidecarHarness();
            for (const body of [{}, { instanceId: 'i-1' }, { group: 'grid-group' }, { instanceId: '', group: 'g' }]) {
                const res = mockRes();
                await h.handlers.sidecarPoll(mockReq({ body }), res);
                assert.strictEqual(res.statusCode, 400);
            }
            assert.strictEqual(h.shutdownManager.getShutdownStatus.mock.calls.length, 0);
        });

        test('poll returns 404 for an unknown group', async () => {
            const h = sidecarHarness();
            h.instanceGroupManager.getInstanceGroup.mock.mockImplementationOnce(() => Promise.resolve(null));
            const res = mockRes();
            await h.handlers.sidecarPoll(mockReq({ body: { instanceId: 'i-1', group: 'nope' } }), res);
            assert.strictEqual(res.statusCode, 404);
            assert.strictEqual(h.shutdownManager.getShutdownStatus.mock.calls.length, 0);
        });

        test('poll succeeds for a known group', async () => {
            const h = sidecarHarness();
            const res = mockRes();
            await h.handlers.sidecarPoll(mockReq({ body: details }), res);
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.body.shutdown, false);
        });

        test('stats and status return 400 without an instance block and 404 for an unknown group', async () => {
            const h = sidecarHarness();
            for (const fn of ['sidecarStats', 'sidecarStatus']) {
                let res = mockRes();
                await h.handlers[fn](mockReq({ body: { stats: {} } }), res);
                assert.strictEqual(res.statusCode, 400, `${fn} missing instance`);

                h.instanceGroupManager.getInstanceGroup.mock.mockImplementationOnce(() => Promise.resolve(null));
                res = mockRes();
                await h.handlers[fn](
                    mockReq({ body: { ...statsBody, instance: { instanceId: 'i-1', group: 'nope' } } }),
                    res,
                );
                assert.strictEqual(res.statusCode, 404, `${fn} unknown group`);
            }
            assert.strictEqual(h.instanceTracker.stats.mock.calls.length, 0);
        });

        test('stats and status succeed for a known group', async () => {
            const h = sidecarHarness();
            let res = mockRes();
            await h.handlers.sidecarStats(mockReq({ body: statsBody }), res);
            assert.strictEqual(res.statusCode, 200);
            res = mockRes();
            await h.handlers.sidecarStatus(mockReq({ body: statsBody }), res);
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(h.instanceTracker.stats.mock.calls.length, 2);
        });

        test('shutdown returns 400/404 on bad input and 200 otherwise', async () => {
            const h = sidecarHarness();
            let res = mockRes();
            await h.handlers.sidecarShutdown(mockReq({ body: {} }), res);
            assert.strictEqual(res.statusCode, 400);

            h.instanceGroupManager.getInstanceGroup.mock.mockImplementationOnce(() => Promise.resolve(null));
            res = mockRes();
            await h.handlers.sidecarShutdown(mockReq({ body: { instanceId: 'i-1', group: 'nope' } }), res);
            assert.strictEqual(res.statusCode, 404);
            assert.strictEqual(h.cloudManager.shutdownInstance.mock.calls.length, 0);

            res = mockRes();
            await h.handlers.sidecarShutdown(mockReq({ body: details }), res);
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(h.cloudManager.shutdownInstance.mock.calls.length, 1);
        });
    });

    describe('getReservation', () => {
        test('passes processingEnabled=false to the manager when autoscaling is off (holds indefinitely)', async () => {
            const h = makeHarness({ enableAutoScale: false });
            const req = mockReq({ params: { name: 'grid-group', id: 'res-1' } });
            const res = mockRes();

            await h.handlers.getReservation(req, res);

            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(h.reservationManager.getReservation.mock.calls.length, 1);
            // Third argument is the group's enableAutoScale flag -> false while held.
            assert.strictEqual(h.reservationManager.getReservation.mock.calls[0].arguments[2], false);
        });

        test('passes processingEnabled=true to the manager when autoscaling is on', async () => {
            const h = makeHarness({ enableAutoScale: true });
            const req = mockReq({ params: { name: 'grid-group', id: 'res-1' } });
            const res = mockRes();

            await h.handlers.getReservation(req, res);

            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(h.reservationManager.getReservation.mock.calls[0].arguments[2], true);
        });
    });
});
