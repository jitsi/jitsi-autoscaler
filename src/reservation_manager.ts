import { nanoid } from 'nanoid/non-secure';
import { Context } from './context';
import { Reservation, ReservationStatus } from './reservation';
import { ReservationStore } from './reservation_store';

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

        const status = minDesired + totalReserved <= maxDesired ? ReservationStatus.Active : ReservationStatus.Pending;

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

    async getReservation(ctx: Context, id: string): Promise<Reservation | null> {
        const reservation = await this.reservationStore.getReservation(ctx, id);
        if (!reservation) {
            return null;
        }
        if (this.isTerminal(reservation.status)) {
            return reservation;
        }
        if (reservation.expiresAt < Date.now()) {
            reservation.status = ReservationStatus.Expired;
            await this.reservationStore.saveReservation(ctx, reservation);
            ctx.logger.info(`Lazily expired reservation ${reservation.id}`);
        }
        return reservation;
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

    async extendReservation(ctx: Context, id: string, ttlSeconds: number): Promise<Reservation | null> {
        const reservation = await this.reservationStore.getReservation(ctx, id);
        if (!reservation) {
            return null;
        }
        if (this.isTerminal(reservation.status)) {
            return null;
        }
        reservation.expiresAt = Date.now() + ttlSeconds * 1000;
        await this.reservationStore.saveReservation(ctx, reservation);
        ctx.logger.info(`Extended reservation ${id} by ${ttlSeconds}s`);
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
                reservation.status = ReservationStatus.Expired;
                await this.reservationStore.saveReservation(ctx, reservation);
                await this.reservationStore.setScaleDownGrace(ctx, groupName, this.scaleDownGraceSec);
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
            if (minDesired + currentReserved + reservation.nodeCount <= maxDesired) {
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

        // Sort active reservations by createdAt so earlier ones are fulfilled first
        const active = reservations
            .filter((r) => r.status === ReservationStatus.Active)
            .sort((a, b) => a.createdAt - b.createdAt);

        let cumulativeReserved = 0;
        for (const reservation of active) {
            cumulativeReserved += reservation.nodeCount;
            if (currentInstanceCount >= minDesired + cumulativeReserved && !reservation.fulfilledAt) {
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
        return status === ReservationStatus.Expired || status === ReservationStatus.Cancelled;
    }
}
