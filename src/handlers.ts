import { Request, Response } from 'express';
import { InstanceTracker, StatsReport, InstanceDetails } from './instance_tracker';
import InstanceGroupManager, { InstanceGroup, InstanceGroupTags } from './instance_group';
import LockManager from './lock_manager';
import Redlock from 'redlock';
import ShutdownManager from './shutdown_manager';
import ReconfigureManager from './reconfigure_manager';
import GroupReportGenerator from './group_report';
import Audit from './audit';
import ScalingManager from './scaling_options_manager';
import * as promClient from 'prom-client';
import CloudManager from './cloud_manager';

const statsErrors = new promClient.Counter({
    name: 'autoscaler_stats_errors',
    help: 'Counter for stats errors',
});

const statsCounter = new promClient.Counter({
    name: 'autoscaler_stats_handled',
    help: 'Counter for sidecar requests handled',
});

interface SidecarResponse {
    shutdown: boolean;
    reconfigure: string;
}

interface InstanceGroupScalingActivitiesRequest {
    enableAutoScale?: boolean;
    enableLaunch?: boolean;
    enableScheduler?: boolean;
    enableUntrackedThrottle?: boolean;
    enableReconfiguration?: boolean;
}

export interface InstanceGroupDesiredValuesRequest {
    minDesired?: number;
    maxDesired?: number;
    desiredCount?: number;
}

interface InstanceGroupScalingOptionsRequest {
    scaleUpQuantity?: number;
    scaleDownQuantity?: number;
    scaleUpThreshold?: number;
    scaleDownThreshold?: number;
    scalePeriod?: number;
    scaleUpPeriodsCount?: number;
    scaleDownPeriodsCount?: number;
    gracePeriodTTLSec?: number;
}
export interface FullScalingOptions {
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
export interface FullScalingOptionsResponse {
    groupsToBeUpdated: number;
    groupsUpdated: number;
}

export interface FullScalingOptionsRequest {
    environment: string;
    direction: string;
    region: string;
    instanceType: string;
    options: FullScalingOptions;
}

export interface ScalingOptionsRequest {
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

interface InstanceConfigurationUpdateRequest {
    instanceConfigurationId: string;
}

interface HandlersOptions {
    cloudManager: CloudManager;
    instanceTracker: InstanceTracker;
    audit: Audit;
    shutdownManager: ShutdownManager;
    reconfigureManager: ReconfigureManager;
    instanceGroupManager: InstanceGroupManager;
    groupReportGenerator: GroupReportGenerator;
    lockManager: LockManager;
    scalingManager: ScalingManager;
}

class Handlers {
    private cloudManager: CloudManager;
    private instanceTracker: InstanceTracker;
    private shutdownManager: ShutdownManager;
    private reconfigureManager: ReconfigureManager;
    private instanceGroupManager: InstanceGroupManager;
    private groupReportGenerator: GroupReportGenerator;
    private lockManager: LockManager;
    private audit: Audit;
    private scalingManager: ScalingManager;

    constructor(options: HandlersOptions) {
        this.sidecarPoll = this.sidecarPoll.bind(this);
        this.sidecarShutdown = this.sidecarShutdown.bind(this);

        this.lockManager = options.lockManager;
        this.cloudManager = options.cloudManager;
        this.instanceTracker = options.instanceTracker;
        this.instanceGroupManager = options.instanceGroupManager;
        this.shutdownManager = options.shutdownManager;
        this.reconfigureManager = options.reconfigureManager;
        this.groupReportGenerator = options.groupReportGenerator;
        this.audit = options.audit;
        this.scalingManager = options.scalingManager;
    }

    async sidecarPoll(req: Request, res: Response): Promise<void> {
        const details: InstanceDetails = req.body;
        statsCounter.inc();
        try {
            const [shutdownStatus, reconfigureDate] = await Promise.all([
                this.shutdownManager.getShutdownStatus(req.context, details.instanceId),
                this.reconfigureManager.getReconfigureDate(req.context, details.instanceId),
            ]);

            const sendResponse: SidecarResponse = {
                shutdown: shutdownStatus,
                reconfigure: reconfigureDate,
            };

            res.status(200);
            res.send(sendResponse);
        } catch (err) {
            req.context.logger.error('Poll handling error', { err });
            statsErrors.inc();

            res.status(500);
            res.send({ save: 'ERROR' });
        }
    }

    async sidecarShutdown(req: Request, res: Response): Promise<void> {
        const details: InstanceDetails = req.body;
        statsCounter.inc();
        try {
            await this.cloudManager.shutdownInstance(req.context, details);

            const sendResponse = {
                save: 'OK',
            };

            res.status(200);
            res.send(sendResponse);
        } catch (err) {
            req.context.logger.error('Shutdown handling error', { err });
            statsErrors.inc();

            res.status(500);
            res.send({ save: 'ERROR' });
        }
    }
    async sidecarStats(req: Request, res: Response): Promise<void> {
        const report: StatsReport = req.body;
        statsCounter.inc();
        try {
            const [shutdownStatus, reconfigureDate] = await Promise.all([
                this.shutdownManager.getShutdownStatus(req.context, report.instance.instanceId),
                this.reconfigureManager.getReconfigureDate(req.context, report.instance.instanceId),
            ]);

            await this.reconfigureManager.processInstanceReport(req.context, report, reconfigureDate);

            await this.instanceTracker.stats(req.context, report, shutdownStatus);

            res.status(200);
            res.send({ save: 'OK' });
        } catch (err) {
            req.context.logger.error('Stats handling error', { err });
            statsErrors.inc();

            res.status(500);
            res.send({ save: 'ERROR' });
        }
    }

    async sidecarStatus(req: Request, res: Response): Promise<void> {
        const report: StatsReport = req.body;
        statsCounter.inc();
        try {
            const [shutdownStatus, reconfigureDate] = await Promise.all([
                this.shutdownManager.getShutdownStatus(req.context, report.instance.instanceId),
                this.reconfigureManager.getReconfigureDate(req.context, report.instance.instanceId),
            ]);

            let postReconfigureDate = reconfigureDate;
            try {
                postReconfigureDate = await this.reconfigureManager.processInstanceReport(
                    req.context,
                    report,
                    reconfigureDate,
                );
                await this.instanceTracker.stats(req.context, report, shutdownStatus);
            } catch (err) {
                req.context.logger.error('Status handling error', { err });
                statsErrors.inc();
            }

            const sendResponse: SidecarResponse = { shutdown: shutdownStatus, reconfigure: postReconfigureDate };

            res.status(200);
            res.send(sendResponse);
        } catch (err) {
            req.context.logger.error('Status overall error', { err });
            statsErrors.inc();

            res.status(500);
            res.send({ save: 'ERROR' });
        }
    }

    async updateDesiredCount(req: Request, res: Response): Promise<void> {
        const request: InstanceGroupDesiredValuesRequest = req.body;
        const lock: Redlock.Lock = await this.lockManager.lockGroup(req.context, req.params.name);
        try {
            const instanceGroup = await this.instanceGroupManager.getInstanceGroup(req.params.name);
            if (instanceGroup) {
                if (request.desiredCount != null) {
                    instanceGroup.scalingOptions.desiredCount = request.desiredCount;
                }
                if (request.maxDesired != null) {
                    instanceGroup.scalingOptions.maxDesired = request.maxDesired;
                }
                if (request.minDesired != null) {
                    instanceGroup.scalingOptions.minDesired = request.minDesired;
                }

                await this.instanceGroupManager.upsertInstanceGroup(req.context, instanceGroup);
                await this.instanceGroupManager.setAutoScaleGracePeriod(req.context, instanceGroup);
                res.status(200);
                res.send({ save: 'OK' });
            } else {
                res.sendStatus(404);
            }
        } finally {
            await lock.unlock();
        }
    }

    async updateScalingActivities(req: Request, res: Response): Promise<void> {
        const scalingActivitiesRequest: InstanceGroupScalingActivitiesRequest = req.body;

        const lock: Redlock.Lock = await this.lockManager.lockGroup(req.context, req.params.name);
        try {
            const instanceGroup = await this.instanceGroupManager.getInstanceGroup(req.params.name);
            if (instanceGroup) {
                if (scalingActivitiesRequest.enableAutoScale != null) {
                    instanceGroup.enableAutoScale = scalingActivitiesRequest.enableAutoScale;
                }
                if (scalingActivitiesRequest.enableLaunch != null) {
                    instanceGroup.enableLaunch = scalingActivitiesRequest.enableLaunch;
                }
                if (scalingActivitiesRequest.enableScheduler != null) {
                    instanceGroup.enableScheduler = scalingActivitiesRequest.enableScheduler;
                }
                if (scalingActivitiesRequest.enableUntrackedThrottle != null) {
                    instanceGroup.enableUntrackedThrottle = scalingActivitiesRequest.enableUntrackedThrottle;
                }

                if (scalingActivitiesRequest.enableReconfiguration != null) {
                    instanceGroup.enableReconfiguration = scalingActivitiesRequest.enableReconfiguration;
                }
                await this.instanceGroupManager.upsertInstanceGroup(req.context, instanceGroup);
                res.status(200);
                res.send({ save: 'OK' });
            } else {
                res.sendStatus(404);
            }
        } finally {
            await lock.unlock();
        }
    }

    async reconfigureInstanceGroup(req: Request, res: Response): Promise<void> {
        const instanceGroup = await this.instanceGroupManager.getInstanceGroup(req.params.name);
        if (instanceGroup) {
            if (instanceGroup.enableReconfiguration) {
                // add audit item recording the request
                await this.audit.updateLastReconfigureRequest(req.context, req.params.name);
                // found the group, so find the instances and act upon them
                // build the list of current instances
                const currentInventory = await this.instanceTracker.trimCurrent(req.context, req.params.name);
                const instances = this.instanceTracker.mapToInstanceDetails(currentInventory);
                // set their reconfigure status to the current date
                try {
                    await this.reconfigureManager.setReconfigureDate(req.context, instances);
                    res.status(200);
                    res.send({ save: 'OK', instances });
                } catch (err) {
                    req.context.logger.error('Error triggering instance reconfiguration', { err });
                    res.status(500);
                    res.send({ save: false, error: 'Failed to trigger reconfiguration' });
                }
            } else {
                res.status(403);
                res.send({ save: false, error: 'Reconfiguration disabled for group' });
            }
        } else {
            res.sendStatus(404);
        }
    }

    async updateInstanceConfiguration(req: Request, res: Response): Promise<void> {
        const instanceConfigurationUpdateRequest: InstanceConfigurationUpdateRequest = req.body;
        const lock: Redlock.Lock = await this.lockManager.lockGroup(req.context, req.params.name);
        try {
            const instanceGroup = await this.instanceGroupManager.getInstanceGroup(req.params.name);
            if (instanceGroup) {
                instanceGroup.instanceConfigurationId = instanceConfigurationUpdateRequest.instanceConfigurationId;
                await this.instanceGroupManager.upsertInstanceGroup(req.context, instanceGroup);
                res.status(200);
                res.send({ save: 'OK' });
            } else {
                res.sendStatus(404);
            }
        } finally {
            await lock.unlock();
        }
    }

    async upsertInstanceGroup(req: Request, res: Response): Promise<void> {
        const instanceGroup: InstanceGroup = req.body;
        if (instanceGroup.name != req.params.name) {
            res.status(400);
            res.send({ errors: ['The request param group name must match group name in the body'] });
            return;
        }
        const lock: Redlock.Lock = await this.lockManager.lockGroup(req.context, instanceGroup.name);
        try {
            await this.instanceGroupManager.upsertInstanceGroup(req.context, instanceGroup);
            await this.instanceGroupManager.setAutoScaleGracePeriod(req.context, instanceGroup);
            res.status(200);
            res.send({ save: 'OK' });
        } finally {
            await lock.unlock();
        }
    }

    async getInstanceGroups(req: Request, res: Response): Promise<void> {
        const expectedTags = <InstanceGroupTags>{};

        for (const propertyName in req.query) {
            if (propertyName.startsWith('tag.')) {
                const key = propertyName.slice('tag.'.length);
                const value = req.query[propertyName] as string;
                expectedTags[key] = value;
            }
        }

        const instanceGroups = await this.instanceGroupManager.getAllInstanceGroupsFiltered(req.context, expectedTags);

        const sortedInstanceGroups = instanceGroups.sort((groupA, groupB) => {
            if (!groupA) {
                return 1;
            } else if (!groupB) {
                return -1;
            } else {
                return groupA.name.localeCompare(groupB.name);
            }
        });

        res.status(200);
        res.send({ instanceGroups: sortedInstanceGroups });
    }

    async getInstanceGroup(req: Request, res: Response): Promise<void> {
        const instanceGroup = await this.instanceGroupManager.getInstanceGroup(req.params.name);

        if (instanceGroup) {
            res.status(200);
            res.send({ instanceGroup });
        } else {
            res.sendStatus(404);
        }
    }

    async deleteInstanceGroup(req: Request, res: Response): Promise<void> {
        const lock: Redlock.Lock = await this.lockManager.lockGroup(req.context, req.params.name);
        try {
            const instanceGroups = await this.instanceGroupManager.deleteInstanceGroup(req.context, req.params.name);

            res.status(200);
            res.send({ instanceGroups: instanceGroups });
        } finally {
            await lock.unlock();
        }
    }

    async getGroupReport(req: Request, res: Response): Promise<void> {
        const groupName = req.params.name;
        const ctx = req.context;
        const group: InstanceGroup = await this.instanceGroupManager.getInstanceGroup(groupName);
        if (group) {
            const groupReport = await this.groupReportGenerator.generateReport(ctx, group, null);
            res.status(200);
            res.send({ groupReport });
        } else {
            res.sendStatus(404);
        }
    }

    async getGroupAudit(req: Request, res: Response): Promise<void> {
        const groupName = req.params.name;
        const ctx = req.context;
        const audit = await this.audit.generateGroupAudit(ctx, groupName);

        res.status(200);
        res.send({ audit });
    }

    async getInstanceAudit(req: Request, res: Response): Promise<void> {
        const groupName = req.params.name;
        const ctx = req.context;
        const audit = await this.audit.generateInstanceAudit(ctx, groupName);

        res.status(200);
        res.send({ audit });
    }

    async resetInstanceGroups(req: Request, res: Response): Promise<void> {
        req.context.logger.info('Resetting instance groups');
        const ctx = req.context;

        const initialGroups = this.instanceGroupManager.getInitialGroups();
        const currentGroupsMap = await this.instanceGroupManager.getAllInstanceGroupsAsMap(req.context);
        await Promise.all(
            initialGroups.map(async (initialGroup) => {
                const lock: Redlock.Lock = await this.lockManager.lockGroup(req.context, initialGroup.name);

                try {
                    if (currentGroupsMap.has(initialGroup.name)) {
                        const currentGroup = currentGroupsMap.get(initialGroup.name);
                        const resetGroup: InstanceGroup = JSON.parse(JSON.stringify(initialGroup));
                        resetGroup.scalingOptions.desiredCount = currentGroup.scalingOptions.desiredCount;
                        ctx.logger.info(
                            `Group ${initialGroup.name} already exists in redis, applying the config over it, without overwriting desired count.`,
                        );
                        await this.instanceGroupManager.upsertInstanceGroup(ctx, resetGroup);
                    } else {
                        ctx.logger.info(
                            `Group ${initialGroup.name} from config does not exist yet in redis. Creating it.`,
                        );
                        await this.instanceGroupManager.upsertInstanceGroup(ctx, initialGroup);
                    }
                } finally {
                    await lock.unlock();
                }
            }),
        );
        ctx.logger.info('Instance groups are now reset');

        res.status(200);
        res.send({ reset: 'OK' });
    }

    async launchProtectedInstanceGroup(req: Request, res: Response): Promise<void> {
        const groupName = req.params.name;
        const lock: Redlock.Lock = await this.lockManager.lockGroup(req.context, groupName);
        try {
            const requestBody = req.body;
            const scaleDownProtectedTTL = requestBody.protectedTTLSec;
            req.context.logger.info('Protecting instances from scaling down', {
                groupName,
                scaleDownProtectedTTL,
            });

            const group = await this.instanceGroupManager.getInstanceGroup(groupName);
            if (group) {
                if (requestBody.instanceConfigurationId != null) {
                    group.instanceConfigurationId = requestBody.instanceConfigurationId;
                }
                if (requestBody.tags && requestBody.tags.length > 0) {
                    Object.entries(requestBody.tags).forEach(([tag, value]) => {
                        group.tags[tag] = <string>value;
                    });
                }
                if (requestBody.maxDesired != null) {
                    group.scalingOptions.maxDesired = requestBody.maxDesired;
                }
                if (requestBody.tags != null) {
                    req.context.logger.debug('Updating group tags', {
                        groupName,
                        tags: requestBody.tags,
                    });
                    if (!group.tags) group.tags = <InstanceGroupTags>{};
                    for (const key in requestBody.tags) {
                        group.tags[key] = requestBody.tags[key];
                    }
                }

                group.scalingOptions.desiredCount = group.scalingOptions.desiredCount + requestBody.count;
                group.protectedTTLSec = scaleDownProtectedTTL;

                await this.instanceGroupManager.upsertInstanceGroup(req.context, group);
                await this.instanceGroupManager.setAutoScaleGracePeriod(req.context, group);
                await this.instanceGroupManager.setScaleDownProtected(group);

                req.context.logger.info(
                    `Newly launched instances in group ${groupName} will be protected for ${scaleDownProtectedTTL} seconds`,
                );

                res.status(200);
                res.send({ launch: 'OK' });
            } else {
                res.sendStatus(404);
            }
        } finally {
            await lock.unlock();
        }
    }

    async updateScalingOptions(req: Request, res: Response): Promise<void> {
        const scalingOptionsRequest: InstanceGroupScalingOptionsRequest = req.body;
        const lock: Redlock.Lock = await this.lockManager.lockGroup(req.context, req.params.name);
        try {
            const instanceGroup = await this.instanceGroupManager.getInstanceGroup(req.params.name);
            if (instanceGroup) {
                if (scalingOptionsRequest.scaleUpQuantity != null) {
                    instanceGroup.scalingOptions.scaleUpQuantity = scalingOptionsRequest.scaleUpQuantity;
                }
                if (scalingOptionsRequest.scaleDownQuantity != null) {
                    instanceGroup.scalingOptions.scaleDownQuantity = scalingOptionsRequest.scaleDownQuantity;
                }
                if (scalingOptionsRequest.scaleUpThreshold != null) {
                    instanceGroup.scalingOptions.scaleUpThreshold = scalingOptionsRequest.scaleUpThreshold;
                }
                if (scalingOptionsRequest.scaleDownThreshold != null) {
                    instanceGroup.scalingOptions.scaleDownThreshold = scalingOptionsRequest.scaleDownThreshold;
                }
                if (scalingOptionsRequest.scalePeriod != null) {
                    instanceGroup.scalingOptions.scalePeriod = scalingOptionsRequest.scalePeriod;
                }
                if (scalingOptionsRequest.scaleUpPeriodsCount != null) {
                    instanceGroup.scalingOptions.scaleUpPeriodsCount = scalingOptionsRequest.scaleUpPeriodsCount;
                }
                if (scalingOptionsRequest.scaleDownPeriodsCount != null) {
                    instanceGroup.scalingOptions.scaleDownPeriodsCount = scalingOptionsRequest.scaleDownPeriodsCount;
                }
                if (scalingOptionsRequest.gracePeriodTTLSec != null) {
                    instanceGroup.gracePeriodTTLSec = scalingOptionsRequest.gracePeriodTTLSec;
                }
                await this.instanceGroupManager.upsertInstanceGroup(req.context, instanceGroup);
                res.status(200);
                res.send({ save: 'OK' });
            } else {
                res.sendStatus(404);
            }
        } finally {
            await lock.unlock();
        }
    }

    async updateFullScalingOptionsForGroups(req: Request, res: Response): Promise<void> {
        const request: FullScalingOptionsRequest = req.body;

        const response: FullScalingOptionsResponse = await this.scalingManager.updateFullScalingOptionsForGroups(
            request,
            req.context,
        );

        res.status(response.groupsToBeUpdated == response.groupsUpdated ? 200 : 206);
        res.send({
            groupsToBeUpdated: response.groupsToBeUpdated,
            groupsUpdated: response.groupsUpdated,
        });
    }
}

export default Handlers;
