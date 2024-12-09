import { Context } from './context';
import Audit from './audit';
import InstanceStore, { InstanceDetails } from './instance_store';

export interface ShutdownManagerOptions {
    instanceStore: InstanceStore;
    shutdownTTL: number;
    audit: Audit;
}

export default class ShutdownManager {
    private instanceStore: InstanceStore;
    private shutdownTTL: number;
    private audit: Audit;

    constructor(options: ShutdownManagerOptions) {
        this.instanceStore = options.instanceStore;
        this.shutdownTTL = options.shutdownTTL;
        this.audit = options.audit;
    }

    async setShutdownStatus(ctx: Context, instanceDetails: InstanceDetails[], status = 'shutdown'): Promise<boolean> {
        const save = await this.instanceStore.setShutdownStatus(ctx, instanceDetails, status, this.shutdownTTL);
        await this.audit.saveShutdownEvents(instanceDetails);
        return save;
    }

    async getShutdownStatuses(ctx: Context, group: string, instanceIds: string[]): Promise<boolean[]> {
        return this.instanceStore.getShutdownStatuses(ctx, group, instanceIds);
    }

    async getShutdownConfirmations(ctx: Context, group: string, instanceIds: string[]): Promise<(string | false)[]> {
        return this.instanceStore.getShutdownConfirmations(ctx, group, instanceIds);
    }

    async getShutdownStatus(ctx: Context, group: string, instanceId: string): Promise<boolean> {
        return this.instanceStore.getShutdownStatus(ctx, group, instanceId);
    }

    async getShutdownConfirmation(ctx: Context, group: string, instanceId: string): Promise<false | string> {
        return this.instanceStore.getShutdownConfirmation(ctx, group, instanceId);
    }

    async setShutdownConfirmation(
        ctx: Context,
        instanceDetails: InstanceDetails[],
        status = new Date().toISOString(),
    ): Promise<boolean> {
        const save = this.instanceStore.setShutdownConfirmation(ctx, instanceDetails, status, this.shutdownTTL);
        await this.audit.saveShutdownConfirmationEvents(instanceDetails);
        return save;
    }

    async setScaleDownProtected(
        ctx: Context,
        group: string,
        instanceId: string,
        protectedTTL: number,
        mode = 'isScaleDownProtected',
    ): Promise<boolean> {
        return this.instanceStore.setScaleDownProtected(ctx, group, instanceId, protectedTTL, mode);
    }

    async areScaleDownProtected(ctx: Context, group: string, instanceIds: string[]): Promise<boolean[]> {
        return this.instanceStore.areScaleDownProtected(ctx, group, instanceIds);
    }
}
