import { Context } from './context';
import { CloudRetryStrategy } from './cloud_manager';
import { InstanceGroup } from './instance_store';

export interface CloudInstance {
    instanceId: string;
    displayName: string;
    cloudStatus: string;
}

export interface CloudInstanceManager {
    launchInstances(
        ctx: Context,
        group: InstanceGroup,
        groupCurrentCount: number,
        quantity: number,
    ): Promise<Array<string | boolean>>;

    getInstances(ctx: Context, group: InstanceGroup, cloudRetryStrategy: CloudRetryStrategy): Promise<CloudInstance[]>;
}

export abstract class AbstractCloudInstanceManager implements CloudInstanceManager {
    static makeRandomString(length: number): string {
        let result = '';
        const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        const charactersLength = characters.length;
        for (let i = 0; i < length; i++) {
            result += characters.charAt(Math.floor(Math.random() * charactersLength));
        }
        return result;
    }

    async launchInstances(
        ctx: Context,
        group: InstanceGroup,
        _groupCurrentCount: number,
        quantity: number,
    ): Promise<Array<string | boolean>> {
        ctx.logger.info(`[CloudInstanceManager] Launching a batch of ${quantity} instances in group ${group.name}`);

        const indexes = <number[]>[];
        for (let i = 0; i < quantity; i++) {
            indexes.push(i);
        }

        const result = await Promise.all(
            indexes.map(async (index) => {
                return this.launchInstance(ctx, index, group);
            }),
        );
        ctx.logger.info(`Finished launching all the instances in group ${group.name}`);

        return result;
    }

    abstract launchInstance(ctx: Context, index: number, group: InstanceGroup): Promise<string | boolean>;

    async getInstances(
        _ctx: Context,
        _group: InstanceGroup,
        _cloudRetryStrategy: CloudRetryStrategy,
    ): Promise<CloudInstance[]> {
        return [];
    }
}
