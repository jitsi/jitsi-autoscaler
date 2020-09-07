import { Request, Response } from 'express';
import { JibriTracker, JibriState } from './jibri_tracker';
import { InstanceStatus, InstanceDetails, StatsReport } from './instance_status';
import InstanceGroupManager, { InstanceGroup } from './instance_group';
import LockManager from './lock_manager';
import Redlock from 'redlock';
import ShutdownManager from './shutdown_manager';
import GroupReportGenerator from './group_report';
import Audit from './audit';

interface SidecarResponse {
    shutdown: boolean;
    reconfigure: boolean;
}

interface InstanceGroupScalingActivitiesRequest {
    enableAutoScale?: boolean;
    enableLaunch?: boolean;
}

export interface InstanceGroupDesiredValuesRequest {
    minDesired?: number;
    maxDesired?: number;
    desiredCount?: number;
}

interface HandlersOptions {
    jibriTracker: JibriTracker;
    audit: Audit;
    instanceStatus: InstanceStatus;
    shutdownManager: ShutdownManager;
    instanceGroupManager: InstanceGroupManager;
    groupReportGenerator: GroupReportGenerator;
    lockManager: LockManager;
}

class Handlers {
    private jibriTracker: JibriTracker;
    private instanceStatus: InstanceStatus;
    private shutdownManager: ShutdownManager;
    private instanceGroupManager: InstanceGroupManager;
    private groupReportGenerator: GroupReportGenerator;
    private lockManager: LockManager;
    private audit: Audit;

    constructor(options: HandlersOptions) {
        this.jibriStateWebhook = this.jibriStateWebhook.bind(this);
        this.sidecarPoll = this.sidecarPoll.bind(this);

        this.lockManager = options.lockManager;
        this.jibriTracker = options.jibriTracker;
        this.instanceStatus = options.instanceStatus;
        this.instanceGroupManager = options.instanceGroupManager;
        this.shutdownManager = options.shutdownManager;
        this.groupReportGenerator = options.groupReportGenerator;
        this.audit = options.audit;
    }

    async jibriStateWebhook(req: Request, res: Response): Promise<void> {
        const status: JibriState = req.body;
        if (!status.status) {
            res.sendStatus(400);
            return;
        }
        if (!status.jibriId) {
            res.sendStatus(400);
            return;
        }

        await this.jibriTracker.track(req.context, status);
        res.sendStatus(200);
    }

    async sidecarPoll(req: Request, res: Response): Promise<void> {
        const details: InstanceDetails = req.body;
        const shutdownStatus = await this.shutdownManager.getShutdownStatus(req.context, details);
        // TODO: implement reconfiguration checks
        const reconfigureStatus = false;

        const sendResponse: SidecarResponse = { shutdown: shutdownStatus, reconfigure: reconfigureStatus };

        res.status(200);
        res.send(sendResponse);
    }

    async sidecarStats(req: Request, res: Response): Promise<void> {
        const report: StatsReport = req.body;
        await this.instanceStatus.stats(req.context, report);

        res.status(200);
        res.send({ save: 'OK' });
    }

    async sidecarStatus(req: Request, res: Response): Promise<void> {
        const report: StatsReport = req.body;
        try {
            await this.instanceStatus.stats(req.context, report);
        } catch (err) {
            req.context.logger.error('Status handling error', { err });
        }
        const shutdownStatus = await this.shutdownManager.getShutdownStatus(req.context, report.instance);
        // TODO: implement reconfiguration checks
        const reconfigureStatus = false;

        const sendResponse: SidecarResponse = { shutdown: shutdownStatus, reconfigure: reconfigureStatus };

        res.status(200);
        res.send(sendResponse);
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
                this.instanceGroupManager.setAutoScaleGracePeriod(instanceGroup);
                res.status(200);
                res.send({ save: 'OK' });
            } else {
                res.status(404);
                res.send();
            }
        } finally {
            lock.unlock();
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
                await this.instanceGroupManager.upsertInstanceGroup(req.context, instanceGroup);
                res.status(200);
                res.send({ save: 'OK' });
            } else {
                res.status(404);
                res.send();
            }
        } finally {
            lock.unlock();
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
            this.instanceGroupManager.setAutoScaleGracePeriod(instanceGroup);
            res.status(200);
            res.send({ save: 'OK' });
        } finally {
            lock.unlock();
        }
    }

    async getInstanceGroups(req: Request, res: Response): Promise<void> {
        const instanceGroups = await this.instanceGroupManager.getAllInstanceGroups(req.context);

        res.status(200);
        res.send({ instanceGroups: instanceGroups });
    }

    async getInstanceGroup(req: Request, res: Response): Promise<void> {
        const instanceGroup = await this.instanceGroupManager.getInstanceGroup(req.params.name);

        if (instanceGroup) {
            res.status(200);
            res.send({ instanceGroup });
        } else {
            res.status(404);
            res.send();
        }
    }

    async deleteInstanceGroup(req: Request, res: Response): Promise<void> {
        const lock: Redlock.Lock = await this.lockManager.lockGroup(req.context, req.params.name);
        try {
            const instanceGroups = await this.instanceGroupManager.deleteInstanceGroup(req.context, req.params.name);

            res.status(200);
            res.send({ instanceGroups: instanceGroups });
        } finally {
            lock.unlock();
        }
    }

    async getGroupReport(req: Request, res: Response): Promise<void> {
        const groupName = req.params.name;
        const ctx = req.context;
        const groupReport = await this.groupReportGenerator.generateReport(ctx, groupName);

        res.status(200);
        res.send({ groupReport });
    }

    async getGroupAudit(req: Request, res: Response): Promise<void> {
        const groupName = req.params.name;
        const ctx = req.context;
        const audit = await this.audit.generateAudit(ctx, groupName);

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
                    lock.unlock();
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
            const scaleDownProtectedTTL = requestBody.scaleDownProtectedTTLSec;
            req.context.logger.info('Protecting instances from scaling down', {
                groupName,
                scaleDownProtectedTTL,
            });

            const group = await this.instanceGroupManager.getInstanceGroup(groupName);
            if (group) {
                if (requestBody.instanceConfigurationId != null) {
                    group.instanceConfigurationId = requestBody.instanceConfigurationId;
                }
                group.scalingOptions.desiredCount = group.scalingOptions.desiredCount + requestBody.count;
                group.protectedTTLSec = requestBody.protectedTTLSec;

                await this.instanceGroupManager.upsertInstanceGroup(req.context, group);
                await this.instanceGroupManager.setAutoScaleGracePeriod(group);
                await this.instanceGroupManager.setScaleDownProtected(group);

                req.context.logger.info(
                    `Newly launched instances in group ${groupName} will be protected for ${scaleDownProtectedTTL} seconds`,
                );

                res.status(200);
                res.send({ launch: 'OK' });
            } else {
                res.status(404);
                res.send();
            }
        } finally {
            lock.unlock();
        }
    }
}

export default Handlers;
