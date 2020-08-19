import { JibriState, JibriStatusState, JibriTracker } from './jibri_tracker';

import logger from './logger';
import CloudManager from './cloud_manager';
import { InstanceDetails } from './instance_status';
import InstanceGroupManager, { InstanceGroup } from './instance_group';
import Redis from 'ioredis';
import Redlock from 'redlock';
import LockManager from './lock_manager';

export interface InstanceLauncherOptions {
    jibriTracker: JibriTracker;
    cloudManager: CloudManager;
    instanceGroupManager: InstanceGroupManager;
    lockManager: LockManager;
    redisClient: Redis.Redis;
}

export default class InstanceLauncher {
    private jibriTracker: JibriTracker;
    private instaceGroupManager: InstanceGroupManager;
    private cloudManager: CloudManager;
    private redisClient: Redis.Redis;
    private lockManager: LockManager;

    constructor(options: InstanceLauncherOptions) {
        this.jibriTracker = options.jibriTracker;
        this.cloudManager = options.cloudManager;
        this.instaceGroupManager = options.instanceGroupManager;
        this.lockManager = options.lockManager;
        this.redisClient = options.redisClient;

        this.launchInstances = this.launchInstances.bind(this);
        this.launchInstancesByGroup = this.launchInstancesByGroup.bind(this);
    }

    async launchInstances(): Promise<boolean> {
        logger.debug('Starting to process scaling activities');
        logger.debug('Obtaining request lock in redis');

        let lock: Redlock.Lock = undefined;
        try {
            lock = await this.lockManager.lockScaleProcessing();
        } catch (err) {
            logger.error(`Error obtaining lock for processing`, { err });
            return false;
        }

        try {
            const instanceGroups: Array<InstanceGroup> = await this.instaceGroupManager.getAllInstanceGroups();
            await Promise.all(instanceGroups.map(this.launchInstancesByGroup));
            logger.debug('Stopped to process scaling activities');
        } catch (err) {
            logger.error(`Processing request ${err}`);
        } finally {
            lock.unlock();
        }
        return true;
    }

    async launchInstancesByGroup(group: InstanceGroup): Promise<boolean> {
        const groupName = group.name;
        const desiredCount = group.scalingOptions.desiredCount;
        const currentInventory = await this.jibriTracker.getCurrent(groupName);
        const count = currentInventory.length;

        const scalingAllowed = await this.instaceGroupManager.allowScaling(groupName);
        if (!scalingAllowed) {
            logger.info(`Wait before allowing another scaling activity for group ${groupName}`);
            return;
        }

        if (count < group.scalingOptions.desiredCount && count < group.scalingOptions.maxDesired) {
            logger.info('Will scale up to the desired count', { groupName, desiredCount });

            const actualScaleUpQuantity =
                Math.min(group.scalingOptions.maxDesired, group.scalingOptions.desiredCount) - count;
            this.cloudManager.scaleUp(group, count, actualScaleUpQuantity);
            this.instaceGroupManager.setScaleGracePeriod(group);
        } else if (count > group.scalingOptions.desiredCount && count > group.scalingOptions.minDesired) {
            logger.info('Will scale down to the desired count', { groupName, desiredCount });

            const actualScaleDownQuantity =
                count - Math.max(group.scalingOptions.minDesired, group.scalingOptions.desiredCount);
            const availableInstances = await this.getAvailableJibris(currentInventory);
            const scaleDownInstances = availableInstances.slice(0, actualScaleDownQuantity);
            this.cloudManager.scaleDown(group, scaleDownInstances);
            this.instaceGroupManager.setScaleGracePeriod(group);
        } else {
            logger.info(`No scaling activity needed for group ${groupName} with ${count} instances.`);
        }

        return true;
    }

    async getAvailableJibris(states: Array<JibriState>): Promise<Array<InstanceDetails>> {
        return states
            .filter((response) => {
                return response.status.busyStatus == JibriStatusState.Idle;
            })
            .map((response) => {
                return {
                    instanceId: response.jibriId,
                    instanceType: 'jibri',
                    group: response.metadata.group,
                };
            });
    }
}
