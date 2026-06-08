/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck

import assert from 'node:assert';
import test, { describe, mock } from 'node:test';

import Handlers from '../handlers';
import { ReservationStatus } from '../reservation';

describe('Handlers reservation on/off behavior', () => {
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
    function makeHarness(groupOverrides = {}, reservationOverrides = {}) {
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

        const instanceGroupManager = {
            getInstanceGroup: mock.fn(() => Promise.resolve(group)),
            upsertInstanceGroup: mock.fn(() => Promise.resolve()),
            setAutoScaleGracePeriod: mock.fn(() => Promise.resolve()),
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
        };

        const handlers = new Handlers({
            lockManager,
            instanceGroupManager,
            reservationManager,
        });

        return { handlers, group, lock, lockManager, instanceGroupManager, reservationManager };
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
