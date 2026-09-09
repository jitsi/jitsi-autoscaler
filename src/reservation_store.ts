import { Context } from './context';
import { Reservation, ReservationStatus } from './reservation';

// Terminal reservations (expired / cancelled) are kept for this long past their expiresAt so callers
// can still read the final status, then the store is allowed to drop them. Non-terminal reservations
// (pending / active / fulfilled) MUST NOT carry a store TTL: a "take and hold" reservation on a group
// with autoscaling off is never re-saved, so any TTL would silently evict it with no Expired status and
// no scale-down grace. Only ReservationManager transitions status, and it re-saves on every transition.
export const DEFAULT_TERMINAL_RESERVATION_RETENTION_SEC = 3600;

export function isTerminalReservationStatus(status: ReservationStatus | undefined): boolean {
    return status === ReservationStatus.Expired || status === ReservationStatus.Cancelled;
}

// Seconds a terminal reservation should be retained by the store: retention past expiresAt, and never
// less than the retention itself (so a reservation expired long ago is still readable for a while).
export function terminalReservationTTLSec(reservation: Reservation, retentionSec: number, now = Date.now()): number {
    return Math.max(Math.ceil((reservation.expiresAt - now) / 1000) + retentionSec, retentionSec);
}

export interface ReservationStore {
    saveReservation: { (ctx: Context, reservation: Reservation): Promise<void> };
    getReservation: { (ctx: Context, id: string): Promise<Reservation | null> };
    listReservations: { (ctx: Context, groupName: string): Promise<Reservation[]> };
    deleteReservation: { (ctx: Context, id: string, groupName: string): Promise<void> };
    setScaleDownGrace: { (ctx: Context, groupName: string, ttlSec: number): Promise<void> };
    isScaleDownGraceActive: { (ctx: Context, groupName: string): Promise<boolean> };
}

export default ReservationStore;
