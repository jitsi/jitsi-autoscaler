import { nanoid } from 'nanoid/non-secure';
import { Context } from './context';
import { Reservation, ReservationStatus } from './reservation';
import { ReservationStore, isTerminalReservationStatus } from './reservation_store';

// Thrown by extendReservation when the reservation exists in the requested group but is already
// terminal (expired / cancelled), so callers can distinguish "conflict" (409) from "not found" (null).
export class ReservationNotExtendableError extends Error {
    readonly reservation: Reservation;

    constructor(reservation: Reservation) {
        super(`Reservation ${reservation.id} is ${reservation.status} and cannot be extended`);
        this.name = 'ReservationNotExtendableError';
        this.reservation = reservation;
    }
}

export interface ReservationManagerOptions {
    reservationStore: ReservationStore;
    defaultTTLSec: number;
    scaleDownGraceSec: number;
    expiryLookaheadSec: number;
}

export default class ReservationManager {
    private reservationStore: ReservationStore;
    private defaultTTLSec: number;
    private scaleDownGraceSec: number;
    private expiryLookaheadSec: number;

    constructor(options: ReservationManagerOptions) {
        this.reservationStore = options.reservationStore;
        this.defaultTTLSec = options.defaultTTLSec;
        this.scaleDownGraceSec = options.scaleDownGraceSec;
        this.expiryLookaheadSec = options.expiryLookaheadSec;
    }

    async createReservation(
        ctx: Context,
        groupName: string,
        nodeCount: number,
        maxDesired: number,
        minDesired: number,
        ttlSeconds?: number,
    ): Promise<Reservation> {
        const ttl = ttlSeconds ?? this.defaultTTLSec;
        const now = Date.now();

        const activeReservations = await this.getActiveReservations(ctx, groupName);
        const totalReserved = activeReservations.reduce((sum, r) => sum + r.nodeCount, 0) + nodeCount;

        const status =
            Math.max(minDesired, totalReserved) <= maxDesired ? ReservationStatus.Active : ReservationStatus.Pending;

        const reservation: Reservation = {
            id: nanoid(12),
            groupName,
            nodeCount,
            status,
            createdAt: now,
            expiresAt: now + ttl * 1000,
        };

        await this.reservationStore.saveReservation(ctx, reservation);
        ctx.logger.info(`Created reservation ${reservation.id} with status ${status}`, {
            groupName,
            nodeCount,
            status,
        });

        return reservation;
    }

    /**
     * Fetch a reservation by id. When processingEnabled is false (the owning group has
     * autoscaling turned off, i.e. "take and hold" mode) the reservation is held
     * indefinitely and is never lazily expired, even past its TTL.
     */
    async getReservation(ctx: Context, id: string, processingEnabled = true): Promise<Reservation | null> {
        const reservation = await this.reservationStore.getReservation(ctx, id);
        if (!reservation) {
            return null;
        }
        if (this.isTerminal(reservation.status)) {
            return reservation;
        }
        if (processingEnabled && reservation.expiresAt < Date.now()) {
            await this.expireReservation(ctx, reservation);
            ctx.logger.info(`Lazily expired reservation ${reservation.id}`);
        }
        return reservation;
    }

    /**
     * Transition a reservation to Expired. Every expiry path (lazy GET and the periodic sweep) must go
     * through here so the scale-down grace is always armed: without it, the autoscaler could scale the
     * freed nodes down instantly the moment a client observed the expiry.
     */
    private async expireReservation(ctx: Context, reservation: Reservation): Promise<void> {
        reservation.status = ReservationStatus.Expired;
        await this.reservationStore.saveReservation(ctx, reservation);
        await this.reservationStore.setScaleDownGrace(ctx, reservation.groupName, this.scaleDownGraceSec);
    }

    async listReservations(
        ctx: Context,
        groupName: string,
        statusFilter?: ReservationStatus[],
    ): Promise<Reservation[]> {
        const reservations = await this.reservationStore.listReservations(ctx, groupName);
        if (statusFilter && statusFilter.length > 0) {
            return reservations.filter((r) => statusFilter.includes(r.status));
        }
        return reservations;
    }

    /**
     * Return the 1-based place in line for a pending reservation, plus the number of
     * reserved nodes ahead of it (promotion is capacity-based, not count-based).
     * Returns null for reservations that are not currently pending.
     */
    async getQueuePosition(ctx: Context, id: string): Promise<{ position: number; aheadNodeCount: number } | null> {
        const reservation = await this.reservationStore.getReservation(ctx, id);
        if (!reservation || reservation.status !== ReservationStatus.Pending) {
            return null;
        }
        const pending = await this.getPendingReservationsFIFO(ctx, reservation.groupName);
        const index = pending.findIndex((r) => r.id === id);
        if (index < 0) {
            return null;
        }
        const aheadNodeCount = pending.slice(0, index).reduce((sum, r) => sum + r.nodeCount, 0);
        return { position: index + 1, aheadNodeCount };
    }

    /**
     * List a group's pending reservations sorted FIFO by createdAt -- the order in
     * which they will be promoted as capacity frees up.
     */
    async getPendingReservationsFIFO(ctx: Context, groupName: string): Promise<Reservation[]> {
        const reservations = await this.reservationStore.listReservations(ctx, groupName);
        return reservations
            .filter((r) => r.status === ReservationStatus.Pending)
            .sort((a, b) => a.createdAt - b.createdAt);
    }

    /**
     * Extend a reservation's TTL. Returns null when no reservation with this id exists in `groupName`
     * (unknown id, or an id that belongs to a different group -- nothing is written in either case).
     * Throws ReservationNotExtendableError when the reservation is already terminal.
     */
    async extendReservation(
        ctx: Context,
        groupName: string,
        id: string,
        ttlSeconds: number,
    ): Promise<Reservation | null> {
        const reservation = await this.reservationStore.getReservation(ctx, id);
        if (!reservation) {
            return null;
        }
        if (reservation.groupName !== groupName) {
            // Must be checked BEFORE the write: extending through the wrong group's endpoint used to
            // persist the new expiresAt and only then be reported as a conflict.
            ctx.logger.warn(`Reservation ${id} belongs to group ${reservation.groupName}, not ${groupName}`);
            return null;
        }
        if (this.isTerminal(reservation.status)) {
            throw new ReservationNotExtendableError(reservation);
        }
        reservation.expiresAt = Date.now() + ttlSeconds * 1000;
        await this.reservationStore.saveReservation(ctx, reservation);
        ctx.logger.info(`Extended reservation ${id} by ${ttlSeconds}s`, { groupName });
        return reservation;
    }

    async cancelReservation(ctx: Context, id: string): Promise<Reservation | null> {
        const reservation = await this.reservationStore.getReservation(ctx, id);
        if (!reservation) {
            return null;
        }
        reservation.status = ReservationStatus.Cancelled;
        await this.reservationStore.saveReservation(ctx, reservation);
        await this.reservationStore.setScaleDownGrace(ctx, reservation.groupName, this.scaleDownGraceSec);
        ctx.logger.info(`Cancelled reservation ${id}, set scale-down grace for ${this.scaleDownGraceSec}s`);
        return reservation;
    }

    async getActiveReservedNodeCount(ctx: Context, groupName: string): Promise<number> {
        const reservations = await this.getActiveReservations(ctx, groupName);
        return reservations.reduce((sum, r) => sum + r.nodeCount, 0);
    }

    async expireStaleReservations(ctx: Context, groupName: string): Promise<string[]> {
        const reservations = await this.reservationStore.listReservations(ctx, groupName);
        const now = Date.now();
        const expiredIds: string[] = [];

        for (const reservation of reservations) {
            if (this.isTerminal(reservation.status)) {
                continue;
            }
            if (reservation.expiresAt < now) {
                await this.expireReservation(ctx, reservation);
                expiredIds.push(reservation.id);
            }
        }

        if (expiredIds.length > 0) {
            ctx.logger.info(`Expired ${expiredIds.length} stale reservations for group ${groupName}`, { expiredIds });
        }
        return expiredIds;
    }

    async promotePendingReservations(
        ctx: Context,
        groupName: string,
        maxDesired: number,
        minDesired: number,
    ): Promise<Reservation[]> {
        const reservations = await this.reservationStore.listReservations(ctx, groupName);
        const now = Date.now();
        const lookaheadMs = this.expiryLookaheadSec * 1000;

        // Check if any active/fulfilled reservations expire soon
        const soonToExpire = reservations.some(
            (r) =>
                (r.status === ReservationStatus.Active || r.status === ReservationStatus.Fulfilled) &&
                r.expiresAt > now &&
                r.expiresAt <= now + lookaheadMs,
        );

        if (soonToExpire) {
            ctx.logger.info(
                `Delaying pending reservation promotion for group ${groupName} -- active reservations expiring within lookahead window`,
            );
            return [];
        }

        // Compute current active reserved count
        const activeReserved = reservations
            .filter((r) => r.status === ReservationStatus.Active || r.status === ReservationStatus.Fulfilled)
            .reduce((sum, r) => sum + r.nodeCount, 0);

        // Sort pending by createdAt (FIFO)
        const pending = reservations
            .filter((r) => r.status === ReservationStatus.Pending)
            .sort((a, b) => a.createdAt - b.createdAt);

        const promoted: Reservation[] = [];
        let currentReserved = activeReserved;

        for (const reservation of pending) {
            if (Math.max(minDesired, currentReserved + reservation.nodeCount) <= maxDesired) {
                reservation.status = ReservationStatus.Active;
                await this.reservationStore.saveReservation(ctx, reservation);
                currentReserved += reservation.nodeCount;
                promoted.push(reservation);
                ctx.logger.info(`Promoted pending reservation ${reservation.id} to active`);
            }
        }

        return promoted;
    }

    async checkAndFulfillReservations(
        ctx: Context,
        groupName: string,
        currentInstanceCount: number,
        minDesired: number,
    ): Promise<void> {
        const reservations = await this.reservationStore.listReservations(ctx, groupName);

        // Capacity already claimed by fulfilled reservations counts first, regardless of creation order:
        // those nodes are occupied, so an active reservation is only covered once instances exceed
        // (all fulfilled) + (active demand ahead of it, FIFO) + (its own demand). Counting only active
        // demand let a later reservation be marked fulfilled while its nodes were still in use by an
        // earlier fulfilled one.
        const fulfilledReserved = reservations
            .filter((r) => r.status === ReservationStatus.Fulfilled)
            .reduce((sum, r) => sum + r.nodeCount, 0);

        // Sort active reservations by createdAt so earlier ones are fulfilled first
        const active = reservations
            .filter((r) => r.status === ReservationStatus.Active)
            .sort((a, b) => a.createdAt - b.createdAt);

        let cumulativeReserved = fulfilledReserved;
        for (const reservation of active) {
            cumulativeReserved += reservation.nodeCount;
            if (currentInstanceCount >= Math.max(minDesired, cumulativeReserved) && !reservation.fulfilledAt) {
                reservation.status = ReservationStatus.Fulfilled;
                reservation.fulfilledAt = Date.now();
                await this.reservationStore.saveReservation(ctx, reservation);
                ctx.logger.info(`Reservation ${reservation.id} fulfilled`);
            }
        }
    }

    async isScaleDownGraceActive(ctx: Context, groupName: string): Promise<boolean> {
        return this.reservationStore.isScaleDownGraceActive(ctx, groupName);
    }

    private async getActiveReservations(ctx: Context, groupName: string): Promise<Reservation[]> {
        const reservations = await this.reservationStore.listReservations(ctx, groupName);
        return reservations.filter(
            (r) =>
                r.status === ReservationStatus.Active ||
                r.status === ReservationStatus.Fulfilled ||
                r.status === ReservationStatus.Pending,
        );
    }

    private isTerminal(status: ReservationStatus): boolean {
        return isTerminalReservationStatus(status);
    }
}
