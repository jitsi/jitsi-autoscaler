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

        test('uses the default TTL when none is provided', async () => {
            const before = Date.now();
            const reservation = await manager.createReservation(context, 'grid-group', 1, 10, 2);
            // defaultTTLSec is 3600 (see manager construction above)
            assert.ok(reservation.expiresAt >= before + 3600 * 1000);
            assert.ok(reservation.expiresAt <= Date.now() + 3600 * 1000);
        });

        test('is active when reserved demand exactly equals maxDesired (boundary)', async () => {
            const reservation = await manager.createReservation(context, 'grid-group', 3, 3, 0); // max(0,3)=3 <= 3
            assert.strictEqual(reservation.status, ReservationStatus.Active);
        });

        test('does not flip to pending due to minDesired when demand fits maxDesired', async () => {
            // minDesired high but still <= maxDesired; decision is driven by reserved demand.
            const reservation = await manager.createReservation(context, 'grid-group', 2, 5, 4); // max(4,2)=4 <= 5
            assert.strictEqual(reservation.status, ReservationStatus.Active);
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

        test('returns a terminal reservation as-is without re-expiring', async () => {
            const reservation = await manager.createReservation(context, 'grid-group', 1, 10, 2);
            await manager.cancelReservation(context, reservation.id);
            // Even past-due, a cancelled reservation must not be flipped to expired.
            savedReservations[reservation.id].expiresAt = Date.now() - 1000;

            const result = await manager.getReservation(context, reservation.id);
            assert.strictEqual(result.status, ReservationStatus.Cancelled);
        });

        test('returns an active reservation unchanged when not past-due', async () => {
            const reservation = await manager.createReservation(context, 'grid-group', 1, 10, 2);
            const result = await manager.getReservation(context, reservation.id);
            assert.strictEqual(result.status, ReservationStatus.Active);
            assert.strictEqual(result.id, reservation.id);
        });

        test('holds a past-due reservation indefinitely when processing is disabled', async () => {
            const reservation = await manager.createReservation(context, 'grid-group', 1, 10, 2, 1);
            // Past-due, but the owning group has autoscaling off ("take and hold" mode).
            savedReservations[reservation.id].expiresAt = Date.now() - 1000;

            const result = await manager.getReservation(context, reservation.id, false);
            assert.strictEqual(result.status, ReservationStatus.Active);
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

        test('returns null for expired reservation', async () => {
            const reservation = await manager.createReservation(context, 'grid-group', 1, 10, 2);
            savedReservations[reservation.id].status = ReservationStatus.Expired;
            const result = await manager.extendReservation(context, reservation.id, 3600);
            assert.strictEqual(result, null);
        });

        test('returns null for non-existent reservation', async () => {
            const result = await manager.extendReservation(context, 'nonexistent', 3600);
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

        test('returns null for non-existent reservation and does not set scale-down grace', async () => {
            mockReservationStore.setScaleDownGrace.mock.resetCalls();
            const result = await manager.cancelReservation(context, 'nonexistent');
            assert.strictEqual(result, null);
            assert.strictEqual(mockReservationStore.setScaleDownGrace.mock.calls.length, 0);
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

        test('includes pending reservations in the reserved count', async () => {
            // minDesired=0, maxDesired=5: first fills capacity (active), second overflows (pending).
            const active = await manager.createReservation(context, 'grid-group', 5, 5, 0);
            const pending = await manager.createReservation(context, 'grid-group', 2, 5, 0);
            assert.strictEqual(active.status, ReservationStatus.Active);
            assert.strictEqual(pending.status, ReservationStatus.Pending);

            // The reservation floor must account for queued demand too: 5 + 2 = 7.
            const count = await manager.getActiveReservedNodeCount(context, 'grid-group');
            assert.strictEqual(count, 7);
        });

        test('includes fulfilled reservations in the reserved count', async () => {
            const r1 = await manager.createReservation(context, 'grid-group', 3, 20, 2);
            await manager.createReservation(context, 'grid-group', 5, 20, 2);
            savedReservations[r1.id].status = ReservationStatus.Fulfilled;

            const count = await manager.getActiveReservedNodeCount(context, 'grid-group');
            assert.strictEqual(count, 8);
        });

        test('excludes expired reservations', async () => {
            await manager.createReservation(context, 'grid-group', 3, 20, 2);
            const r2 = await manager.createReservation(context, 'grid-group', 2, 20, 2);
            savedReservations[r2.id].status = ReservationStatus.Expired;

            const count = await manager.getActiveReservedNodeCount(context, 'grid-group');
            assert.strictEqual(count, 3);
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

        test('does not expire still-valid reservations and does not set scale-down grace', async () => {
            mockReservationStore.setScaleDownGrace.mock.resetCalls();
            const r = await manager.createReservation(context, 'grid-group', 2, 10, 2);

            const expiredIds = await manager.expireStaleReservations(context, 'grid-group');
            assert.strictEqual(expiredIds.length, 0);
            assert.strictEqual(savedReservations[r.id].status, ReservationStatus.Active);
            assert.strictEqual(mockReservationStore.setScaleDownGrace.mock.calls.length, 0);
        });

        test('skips already-terminal reservations even when past-due', async () => {
            const r = await manager.createReservation(context, 'grid-group', 2, 10, 2);
            await manager.cancelReservation(context, r.id);
            savedReservations[r.id].expiresAt = Date.now() - 1000;

            const expiredIds = await manager.expireStaleReservations(context, 'grid-group');
            assert.strictEqual(expiredIds.length, 0);
            // Stays cancelled -- terminal reservations are never re-expired.
            assert.strictEqual(savedReservations[r.id].status, ReservationStatus.Cancelled);
        });

        test('expires only the stale reservations in a mixed batch', async () => {
            const valid = await manager.createReservation(context, 'grid-group', 2, 20, 2);
            const stale = await manager.createReservation(context, 'grid-group', 2, 20, 2);
            savedReservations[stale.id].expiresAt = Date.now() - 1000;

            const expiredIds = await manager.expireStaleReservations(context, 'grid-group');
            assert.deepStrictEqual(expiredIds, [stale.id]);
            assert.strictEqual(savedReservations[valid.id].status, ReservationStatus.Active);
            assert.strictEqual(savedReservations[stale.id].status, ReservationStatus.Expired);
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

        test('promotes nothing when there are no pending reservations', async () => {
            await manager.createReservation(context, 'grid-group', 2, 10, 2); // active, not pending

            const promoted = await manager.promotePendingReservations(context, 'grid-group', 10, 2);
            assert.strictEqual(promoted.length, 0);
        });

        test('does not promote a pending reservation that does not fit remaining capacity', async () => {
            // Active reservation fills capacity to 4 of 5 (minDesired=0, maxDesired=5).
            await manager.createReservation(context, 'grid-group', 4, 5, 0);
            // Pending reservation needs 2 -> 4+2=6 > 5, cannot be promoted.
            const pending = await manager.createReservation(context, 'grid-group', 2, 5, 0);
            assert.strictEqual(pending.status, ReservationStatus.Pending);

            const promoted = await manager.promotePendingReservations(context, 'grid-group', 5, 0);
            assert.strictEqual(promoted.length, 0);
            assert.strictEqual(savedReservations[pending.id].status, ReservationStatus.Pending);
        });

        test('promotes multiple pending reservations in FIFO order when all fit', async () => {
            // Filler reservation occupies all capacity, then two pending queue behind it.
            const filler = await manager.createReservation(context, 'grid-group', 10, 10, 0);
            const p1 = await manager.createReservation(context, 'grid-group', 2, 10, 0);
            const p2 = await manager.createReservation(context, 'grid-group', 3, 10, 0);
            assert.strictEqual(p1.status, ReservationStatus.Pending);
            assert.strictEqual(p2.status, ReservationStatus.Pending);
            savedReservations[p1.id].createdAt = 1000;
            savedReservations[p2.id].createdAt = 2000;

            // Free all capacity so both pending fit.
            await manager.cancelReservation(context, filler.id);

            const promoted = await manager.promotePendingReservations(context, 'grid-group', 10, 0);
            assert.deepStrictEqual(
                promoted.map((r) => r.id),
                [p1.id, p2.id],
            );
        });

        test('packs by best-fit: a smaller pending reservation is promoted ahead of a larger one that does not fit', async () => {
            // Documents intentional best-fit packing (not strict FIFO): with only 1 free
            // node, the head-of-line 2-node reservation is skipped and the 1-node one behind
            // it is promoted instead.
            await manager.createReservation(context, 'grid-group', 2, 3, 0); // active, activeReserved=2, free=1
            const big = await manager.createReservation(context, 'grid-group', 2, 3, 0); // pending (2+2=4 > 3)
            const small = await manager.createReservation(context, 'grid-group', 1, 3, 0); // pending (2+1=3 <= 3 once promoted)
            assert.strictEqual(big.status, ReservationStatus.Pending);
            assert.strictEqual(small.status, ReservationStatus.Pending);
            // big is ahead of small in the queue.
            savedReservations[big.id].createdAt = 1000;
            savedReservations[small.id].createdAt = 2000;

            const promoted = await manager.promotePendingReservations(context, 'grid-group', 3, 0);
            assert.deepStrictEqual(
                promoted.map((r) => r.id),
                [small.id],
            );
            assert.strictEqual(savedReservations[big.id].status, ReservationStatus.Pending);
            assert.strictEqual(savedReservations[small.id].status, ReservationStatus.Active);
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

        test('fulfills earlier reservations first based on cumulative reserved count', async () => {
            const r1 = await manager.createReservation(context, 'grid-group', 2, 20, 0);
            const r2 = await manager.createReservation(context, 'grid-group', 3, 20, 0);
            // Deterministic FIFO order regardless of createdAt collisions.
            savedReservations[r1.id].createdAt = 1000;
            savedReservations[r2.id].createdAt = 2000;

            // 2 instances: covers r1 (cumulative 2) but not r1+r2 (cumulative 5).
            await manager.checkAndFulfillReservations(context, 'grid-group', 2, 0);

            assert.strictEqual(savedReservations[r1.id].status, ReservationStatus.Fulfilled);
            assert.strictEqual(savedReservations[r2.id].status, ReservationStatus.Active);
        });

        test('fulfills all active reservations when instance count covers cumulative demand', async () => {
            const r1 = await manager.createReservation(context, 'grid-group', 2, 20, 0);
            const r2 = await manager.createReservation(context, 'grid-group', 3, 20, 0);
            savedReservations[r1.id].createdAt = 1000;
            savedReservations[r2.id].createdAt = 2000;

            await manager.checkAndFulfillReservations(context, 'grid-group', 5, 0);

            assert.strictEqual(savedReservations[r1.id].status, ReservationStatus.Fulfilled);
            assert.strictEqual(savedReservations[r2.id].status, ReservationStatus.Fulfilled);
        });

        test('respects the minDesired floor before fulfilling', async () => {
            const r = await manager.createReservation(context, 'grid-group', 1, 10, 0);

            // 2 instances but minDesired=3: need max(3,1)=3, so not yet fulfilled.
            await manager.checkAndFulfillReservations(context, 'grid-group', 2, 3);
            assert.strictEqual(savedReservations[r.id].status, ReservationStatus.Active);

            // 3 instances now meets the floor.
            await manager.checkAndFulfillReservations(context, 'grid-group', 3, 3);
            assert.strictEqual(savedReservations[r.id].status, ReservationStatus.Fulfilled);
        });

        test('does not re-fulfill an already-fulfilled reservation', async () => {
            const r = await manager.createReservation(context, 'grid-group', 1, 10, 0);
            await manager.checkAndFulfillReservations(context, 'grid-group', 5, 0);
            const firstFulfilledAt = savedReservations[r.id].fulfilledAt;
            assert.ok(firstFulfilledAt);

            await manager.checkAndFulfillReservations(context, 'grid-group', 5, 0);
            assert.strictEqual(savedReservations[r.id].status, ReservationStatus.Fulfilled);
            assert.strictEqual(savedReservations[r.id].fulfilledAt, firstFulfilledAt);
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

    describe('getQueuePosition', () => {
        test('returns 1-based position and nodes ahead for pending reservations (FIFO)', async () => {
            // minDesired=0, maxDesired=1: first reservation is active, rest pending.
            const r1 = await manager.createReservation(context, 'grid-group', 1, 1, 0);
            assert.strictEqual(r1.status, ReservationStatus.Active);
            const r2 = await manager.createReservation(context, 'grid-group', 2, 1, 0);
            const r3 = await manager.createReservation(context, 'grid-group', 3, 1, 0);
            assert.strictEqual(r2.status, ReservationStatus.Pending);
            assert.strictEqual(r3.status, ReservationStatus.Pending);

            // Ensure deterministic FIFO ordering regardless of createdAt collisions.
            savedReservations[r2.id].createdAt = 1000;
            savedReservations[r3.id].createdAt = 2000;

            const q2 = await manager.getQueuePosition(context, r2.id);
            assert.deepStrictEqual(q2, { position: 1, aheadNodeCount: 0 });

            const q3 = await manager.getQueuePosition(context, r3.id);
            assert.deepStrictEqual(q3, { position: 2, aheadNodeCount: 2 });
        });

        test('returns null for non-pending reservations', async () => {
            const r = await manager.createReservation(context, 'grid-group', 1, 10, 0);
            assert.strictEqual(r.status, ReservationStatus.Active);
            const q = await manager.getQueuePosition(context, r.id);
            assert.strictEqual(q, null);
        });

        test('returns null for non-existent reservation', async () => {
            const q = await manager.getQueuePosition(context, 'nonexistent');
            assert.strictEqual(q, null);
        });
    });
});
