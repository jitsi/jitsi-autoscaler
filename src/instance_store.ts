import { CloudInstance } from './cloud_manager';
import { Context } from './context';

export interface InstanceGroup {
    id: string;
    name: string;
    type: string;
    region: string;
    environment: string;
    compartmentId: string;
    instanceConfigurationId: string;
    enableAutoScale: boolean;
    enableLaunch: boolean;
    enableScheduler: boolean;
    enableUntrackedThrottle: boolean;
    enableReconfiguration?: boolean;
    gracePeriodTTLSec: number;
    protectedTTLSec: number;
    scalingOptions: ScalingOptions;
    cloud: string;
    tags: InstanceGroupTags;
}

export interface ScalingOptions {
    minDesired: number;
    maxDesired: number;
    desiredCount: number;
    scaleUpQuantity: number;
    scaleDownQuantity: number;
    scaleUpThreshold: number;
    scaleDownThreshold: number;
    scalePeriod: number;
    scaleUpPeriodsCount: number;
    scaleDownPeriodsCount: number;
}

export interface InstanceGroupTags {
    [id: string]: string;
}

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

export interface InstanceStore {
    // instance related methods
    fetchInstanceStates: { (ctx: Context, group: string): Promise<InstanceState[]> };
    saveInstanceStatus: { (ctx: Context, group: string, state: InstanceState): Promise<boolean> };
    filterOutAndTrimExpiredStates: { (ctx: Context, group: string, states: InstanceState[]): Promise<InstanceState[]> };

    // shutdown related methods
    setShutdownStatus: {
        (ctx: Context, instanceDetails: InstanceDetails[], status: string, ttl: number): Promise<boolean>;
    };
    getShutdownStatuses: { (ctx: Context, group: string, instanceIds: string[]): Promise<boolean[]> };
    getShutdownConfirmations: { (ctx: Context, group: string, instanceIds: string[]): Promise<(string | false)[]> };
    getShutdownStatus: { (ctx: Context, group: string, instanceId: string): Promise<boolean> };
    getShutdownConfirmation: { (ctx: Context, group: string, instanceId: string): Promise<false | string> };
    setShutdownConfirmation: {
        (ctx: Context, instanceDetails: InstanceDetails[], status: string, ttl: number): Promise<boolean>;
    };
    setScaleDownProtected: {
        (ctx: Context, group: string, instanceId: string, protectedTTL: number, mode: string): Promise<boolean>;
    };
    areScaleDownProtected: { (ctx: Context, group: string, instanceIds: string[]): Promise<boolean[]> };

    // reconfigure related methods
    setReconfigureDate: {
        (ctx: Context, instanceDetails: InstanceDetails[], date: string, ttl: number): Promise<boolean>;
    };
    unsetReconfigureDate: { (ctx: Context, instanceId: string, group: string): Promise<boolean> };
    getReconfigureDates: { (ctx: Context, group: string, instanceIds: string[]): Promise<string[]> };
    getReconfigureDate: { (ctx: Context, group: string, instanceId: string): Promise<string> };

    // group related methods
    existsAtLeastOneGroup: { (ctx: Context): Promise<boolean> };
    upsertInstanceGroup: { (ctx: Context, group: InstanceGroup): Promise<boolean> };
    getInstanceGroup: { (ctx: Context, groupName: string): Promise<InstanceGroup> };
    getAllInstanceGroups: { (ctx: Context): Promise<InstanceGroup[]> };
    getAllInstanceGroupNames: { (ctx: Context): Promise<string[]> };
    deleteInstanceGroup: { (ctx: Context, groupName: string): Promise<void> };

    // key related methods
    checkValue: { (ctx: Context, key: string): Promise<boolean> };
    setValue: { (ctx: Context, key: string, value: string, ttl: number): Promise<boolean> };

    // sanity related
    saveCloudInstances: { (ctx: Context, groupName: string, cloudInstances: CloudInstance[]): Promise<boolean> };
}

export default InstanceStore;
