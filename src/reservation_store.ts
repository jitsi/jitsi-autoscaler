import { Context } from './context';
import { Reservation } from './reservation';

export interface ReservationStore {
    saveReservation: { (ctx: Context, reservation: Reservation): Promise<void> };
    getReservation: { (ctx: Context, id: string): Promise<Reservation | null> };
    listReservations: { (ctx: Context, groupName: string): Promise<Reservation[]> };
    deleteReservation: { (ctx: Context, id: string, groupName: string): Promise<void> };
    setScaleDownGrace: { (ctx: Context, groupName: string, ttlSec: number): Promise<void> };
    isScaleDownGraceActive: { (ctx: Context, groupName: string): Promise<boolean> };
}

export default ReservationStore;
