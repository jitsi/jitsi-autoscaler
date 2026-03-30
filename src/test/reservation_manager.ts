/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck

import assert from 'node:assert';
import test, { afterEach, describe, mock } from 'node:test';

import ReservationManager from '../reservation_manager';
import { ReservationStatus } from '../reservation';

describe('ReservationManager', () => {
    const context = {
        logger: {
            info: mock.fn(),
            debug: mock.fn(),
            error: mock.fn(),
            warn: mock.fn(),
        },
    };

    const savedReservations = {};

    const mockReservationStore = {
        saveReservation: mock.fn((_ctx, reservation) => {
            savedReservations[reservation.id] = JSON.parse(JSON.stringify(reservation));
            return Promise.resolve();
        }),
        getReservation: mock.fn((_ctx, id) => {
            const r = savedReservations[id];
            return Promise.resolve(r ? JSON.parse(JSON.stringify(r)) : null);
        }),
        listReservations: mock.fn((_ctx, groupName) => {
            const results = Object.values(savedReservations).filter((r) => r.groupName === groupName);
            return Promise.resolve(results.map((r) => JSON.parse(JSON.stringify(r))));
        }),
        deleteReservation: mock.fn((_ctx, id) => {
            delete savedReservations[id];
            return Promise.resolve();
        }),
        setScaleDownGrace: mock.fn(() => Promise.resolve()),
        isScaleDownGraceActive: mock.fn(() => Promise.resolve(false)),
    };

    const manager = new ReservationManager({
        reservationStore: mockReservationStore,
        defaultTTLSec: 3600,
        scaleDownGraceSec: 300,
        expiryLookaheadSec: 600,
    });

    afterEach(() => {
        for (const key of Object.keys(savedReservations)) {
            delete savedReservations[key];
        }
        mock.restoreAll();
    });

    describe('createReservation', () => {
        test('creates an active reservation when capacity is available', async () => {
            const reservation = await manager.createReservation(context, 'grid-group', 3, 10, 2);
            assert.strictEqual(reservation.status, ReservationStatus.Active);
            assert.strictEqual(reservation.nodeCount, 3);
            assert.strictEqual(reservation.groupName, 'grid-group');
            assert.ok(reservation.id);
            assert.ok(reservation.expiresAt > Date.now());
        });

        test('creates a pending reservation when capacity is exceeded', async () => {
            // Fill up capacity: minDesired=2, maxDesired=5
            await manager.createReservation(context, 'grid-group', 4, 5, 2); // max(2,4)=4 <= 5, active
            const pending = await manager.createReservation(context, 'grid-group', 2, 5, 2); // max(2,6)=6 > 5
            assert.strictEqual(pending.status, ReservationStatus.Pending);
        });

        test('uses custom TTL when provided', async () => {
            const before = Date.now();
            const reservation = await manager.createReservation(context, 'grid-group', 1, 10, 2, 7200);
            assert.ok(reservation.expiresAt >= before + 7200 * 1000);
        });
    });

    describe('getReservation', () => {
        test('returns null for non-existent reservation', async () => {
            const result = await manager.getReservation(context, 'nonexistent');
            assert.strictEqual(result, null);
        });

        test('lazily expires a past-due reservation', async () => {
            const reservation = await manager.createReservation(context, 'grid-group', 1, 10, 2, 1);
            // Manually set expiresAt to the past
            savedReservations[reservation.id].expiresAt = Date.now() - 1000;

            const result = await manager.getReservation(context, reservation.id);
            assert.strictEqual(result.status, ReservationStatus.Expired);
        });
    });

    describe('extendReservation', () => {
        test('extends TTL of an active reservation', async () => {
            const reservation = await manager.createReservation(context, 'grid-group', 1, 10, 2);
            const before = Date.now();
            const extended = await manager.extendReservation(context, reservation.id, 7200);
            assert.ok(extended.expiresAt >= before + 7200 * 1000);
        });

        test('returns null for cancelled reservation', async () => {
            const reservation = await manager.createReservation(context, 'grid-group', 1, 10, 2);
            await manager.cancelReservation(context, reservation.id);
            const result = await manager.extendReservation(context, reservation.id, 3600);
            assert.strictEqual(result, null);
        });
    });

    describe('cancelReservation', () => {
        test('marks reservation as cancelled and sets scale-down grace', async () => {
            const reservation = await manager.createReservation(context, 'grid-group', 1, 10, 2);
            const cancelled = await manager.cancelReservation(context, reservation.id);
            assert.strictEqual(cancelled.status, ReservationStatus.Cancelled);
            assert.ok(mockReservationStore.setScaleDownGrace.mock.calls.length > 0);
        });
    });

    describe('getActiveReservedNodeCount', () => {
        test('sums node counts of active and fulfilled reservations', async () => {
            await manager.createReservation(context, 'grid-group', 3, 20, 2);
            await manager.createReservation(context, 'grid-group', 5, 20, 2);

            const count = await manager.getActiveReservedNodeCount(context, 'grid-group');
            assert.strictEqual(count, 8);
        });

        test('excludes cancelled reservations', async () => {
            const r1 = await manager.createReservation(context, 'grid-group', 3, 20, 2);
            await manager.createReservation(context, 'grid-group', 5, 20, 2);
            await manager.cancelReservation(context, r1.id);

            const count = await manager.getActiveReservedNodeCount(context, 'grid-group');
            assert.strictEqual(count, 5);
        });
    });

    describe('expireStaleReservations', () => {
        test('expires past-due reservations and sets scale-down grace', async () => {
            const r = await manager.createReservation(context, 'grid-group', 2, 10, 2);
            savedReservations[r.id].expiresAt = Date.now() - 1000;

            const expiredIds = await manager.expireStaleReservations(context, 'grid-group');
            assert.strictEqual(expiredIds.length, 1);
            assert.strictEqual(expiredIds[0], r.id);

            const updated = savedReservations[r.id];
            assert.strictEqual(updated.status, ReservationStatus.Expired);
        });
    });

    describe('promotePendingReservations', () => {
        test('promotes pending to active when capacity frees up', async () => {
            // Create active reservation using all capacity (minDesired=2, maxDesired=5, reserve 5 -> max(2,5)=5)
            const r1 = await manager.createReservation(context, 'grid-group', 5, 5, 2);
            // This will be pending (max(2,5+2)=7 > 5)
            const r2 = await manager.createReservation(context, 'grid-group', 2, 5, 2);
            assert.strictEqual(r2.status, ReservationStatus.Pending);

            // Cancel r1 to free capacity
            await manager.cancelReservation(context, r1.id);

            const promoted = await manager.promotePendingReservations(context, 'grid-group', 5, 2);
            assert.strictEqual(promoted.length, 1);
            assert.strictEqual(promoted[0].id, r2.id);
            assert.strictEqual(promoted[0].status, ReservationStatus.Active);
        });

        test('delays promotion when active reservations expire within lookahead window', async () => {
            // Create an active reservation expiring within lookahead (600s)
            const r1 = await manager.createReservation(context, 'grid-group', 3, 5, 2);
            savedReservations[r1.id].expiresAt = Date.now() + 300 * 1000; // 300s < 600s lookahead

            // Cancel r1 to make it not block capacity, but add a non-cancelled soon-expiring one
            const r2 = await manager.createReservation(context, 'grid-group', 1, 10, 2);
            savedReservations[r2.id].status = ReservationStatus.Pending;
            savedReservations[r2.id].expiresAt = Date.now() + 7200 * 1000;

            // r1 is active and expires soon -- should delay r2 promotion
            const promoted = await manager.promotePendingReservations(context, 'grid-group', 10, 2);
            assert.strictEqual(promoted.length, 0);
        });
    });

    describe('checkAndFulfillReservations', () => {
        test('marks active reservation as fulfilled when instance count is sufficient', async () => {
            const r = await manager.createReservation(context, 'grid-group', 3, 10, 2);

            // Simulate 3 instances running (minDesired=2, reserved=3, need max(2,3)=3)
            await manager.checkAndFulfillReservations(context, 'grid-group', 3, 2);

            const updated = savedReservations[r.id];
            assert.strictEqual(updated.status, ReservationStatus.Fulfilled);
            assert.ok(updated.fulfilledAt);
        });

        test('does not fulfill when instance count is insufficient', async () => {
            const r = await manager.createReservation(context, 'grid-group', 5, 10, 2);

            // Only 3 instances (need max(2,5)=5)
            await manager.checkAndFulfillReservations(context, 'grid-group', 3, 2);

            const updated = savedReservations[r.id];
            assert.strictEqual(updated.status, ReservationStatus.Active);
        });
    });

    describe('listReservations', () => {
        test('filters by status when provided', async () => {
            const r1 = await manager.createReservation(context, 'grid-group', 1, 10, 2);
            await manager.createReservation(context, 'grid-group', 1, 10, 2);
            await manager.cancelReservation(context, r1.id);

            const active = await manager.listReservations(context, 'grid-group', [ReservationStatus.Active]);
            assert.strictEqual(active.length, 1);

            const cancelled = await manager.listReservations(context, 'grid-group', [ReservationStatus.Cancelled]);
            assert.strictEqual(cancelled.length, 1);
        });

        test('returns all when no filter', async () => {
            await manager.createReservation(context, 'grid-group', 1, 10, 2);
            await manager.createReservation(context, 'grid-group', 1, 10, 2);

            const all = await manager.listReservations(context, 'grid-group');
            assert.strictEqual(all.length, 2);
        });
    });
});
