import { Context } from './context';

export interface NomadStatus {
    stress_level: number;
    totalCPU: number;
    eligibleForScheduling: boolean;
    allocatedCPU: number;
    allocatedMemory: number;
    unallocatedCPU: number;
    unallocatedMemory: number;
}

export interface JigasiStatus {
    stress_level: number;
    // muc_clients_configured: number;
    // muc_clients_connected: number;
    conferences: number;
    participants: number;
    // largest_conference: number;
    graceful_shutdown: boolean;
}

export interface InstanceDetails {
    instanceId: string;
    instanceType: string;
    cloud?: string;
    region?: string;
    group?: string;
    name?: string;
    version?: string;
    publicIp?: string;
    privateIp?: string;
}

export interface InstanceMetadata {
    group: string;
    publicIp?: string;
    privateIp?: string;
    version?: string;
    name?: string;

    [key: string]: string;
}

export enum JibriStatusState {
    Idle = 'IDLE',
    Busy = 'BUSY',
    Expired = 'EXPIRED',
}

export enum JibriHealthState {
    Healthy = 'HEALTHY',
    Unhealthy = 'UNHEALTHY',
}

export interface JibriStatus {
    busyStatus: JibriStatusState;
    health: JibriHealth;
}

export interface JibriHealth {
    healthStatus: JibriHealthState;
}

export interface JVBStatus {
    stress_level: number;
    muc_clients_configured: number;
    muc_clients_connected: number;
    conferences: number;
    participants: number;
    largest_conference: number;
    graceful_shutdown: boolean;
}

export interface InstanceStatus {
    provisioning: boolean;
    jibriStatus?: JibriStatus;
    jvbStatus?: JVBStatus;
    jigasiStatus?: JigasiStatus;
    nomadStatus?: NomadStatus;
}

export interface InstanceState {
    instanceId: string;
    instanceType: string;
    status: InstanceStatus;
    timestamp?: number;
    metadata: InstanceMetadata;
    isShuttingDown?: boolean;
    shutdownStatus?: boolean;
    shutdownComplete?: string;
    reconfigureError?: boolean;
    shutdownError?: boolean;
    statsError?: boolean;
    lastReconfigured?: string;
}

interface InstanceStore {
    // instance related methods
    fetchInstanceGroups: { (): Promise<string[]> };
    fetchInstanceStates: { (ctx: Context, group: string): Promise<InstanceState[]> };
    saveInstanceStatus: { (ctx: Context, group: string, state: InstanceState): Promise<boolean> };
    filterOutAndTrimExpiredStates: { (ctx: Context, group: string, states: InstanceState[]): Promise<InstanceState[]> };

    // shutdown related methods
    setShutdownStatus: {
        (ctx: Context, instanceDetails: InstanceDetails[], status: string, ttl: number): Promise<boolean>;
    };
    getShutdownStatuses: { (ctx: Context, instanceIds: string[]): Promise<boolean[]> };
    getShutdownConfirmations: { (ctx: Context, instanceIds: string[]): Promise<(string | false)[]> };
    getShutdownStatus: { (ctx: Context, instanceId: string): Promise<boolean> };
    getShutdownConfirmation: { (ctx: Context, instanceId: string): Promise<false | string> };
    setShutdownConfirmation: {
        (ctx: Context, instanceDetails: InstanceDetails[], status: string, ttl: number): Promise<boolean>;
    };
    setScaleDownProtected: { (ctx: Context, instanceId: string, protectedTTL: number, mode: string): Promise<boolean> };
    areScaleDownProtected: { (ctx: Context, instanceIds: string[]): Promise<boolean[]> };

    // reconfigure related methods
    setReconfigureDate: {
        (ctx: Context, instanceDetails: InstanceDetails[], date: string, ttl: number): Promise<boolean>;
    };
    unsetReconfigureDate: { (ctx: Context, instanceId: string, group: string): Promise<boolean> };
    getReconfigureDates: { (ctx: Context, instanceIds: string[]): Promise<string[]> };
    getReconfigureDate: { (ctx: Context, instanceId: string): Promise<string> };
}

export default InstanceStore;
