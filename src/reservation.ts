export enum ReservationStatus {
    Pending = 'pending',
    Active = 'active',
    Fulfilled = 'fulfilled',
    Expired = 'expired',
    Cancelled = 'cancelled',
}

export interface Reservation {
    id: string;
    groupName: string;
    nodeCount: number;
    status: ReservationStatus;
    createdAt: number;
    expiresAt: number;
    fulfilledAt?: number;
}

export interface CreateReservationRequest {
    nodeCount: number;
    ttlSeconds?: number;
}

export interface ExtendReservationRequest {
    ttlSeconds: number;
}
