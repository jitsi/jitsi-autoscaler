import { Request, Response } from 'express';
import { JibriTracker, JibriState } from './jibri_tracker';
import { InstanceStatus, InstanceDetails, StatsReport } from './instance_status';
import InstanceGroupManager, { InstanceGroup } from './instance_group';
import LockManager from './lock_manager';
import Redlock from 'redlock';
import ShutdownManager from './shutdown_manager';

interface SidecarResponse {
    shutdown: boolean;
    reconfigure: boolean;
}

interface InstanceGroupUpdateRequest {
    desiredCount: number;
}

class Handlers {
    private jibriTracker: JibriTracker;
    private instanceStatus: InstanceStatus;
    private shutdownManager: ShutdownManager;
    private instanceGroupManager: InstanceGroupManager;
    private lockManager: LockManager;

    constructor(
        jibriTracker: JibriTracker,
        instanceStatus: InstanceStatus,
        shutdownManager: ShutdownManager,
        instanceGroupManager: InstanceGroupManager,
        lockManager: LockManager,
    ) {
        this.jibriStateWebhook = this.jibriStateWebhook.bind(this);
        this.sidecarPoll = this.sidecarPoll.bind(this);

        this.lockManager = lockManager;
        this.jibriTracker = jibriTracker;
        this.instanceStatus = instanceStatus;
        this.instanceGroupManager = instanceGroupManager;
        this.shutdownManager = shutdownManager;
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
        await this.instanceStatus.stats(req.context, report);
        const shutdownStatus = await this.shutdownManager.getShutdownStatus(req.context, report.instance);
        // TODO: implement reconfiguration checks
        const reconfigureStatus = false;

        const sendResponse: SidecarResponse = { shutdown: shutdownStatus, reconfigure: reconfigureStatus };

        res.status(200);
        res.send(sendResponse);
    }

    async upsertDesiredCount(req: Request, res: Response): Promise<void> {
        const request: InstanceGroupUpdateRequest = req.body;
        const lock: Redlock.Lock = await this.lockManager.lockAutoscaleProcessing(req.context);
        try {
            const instanceGroup = await this.instanceGroupManager.getInstanceGroup(req.params.name);
            instanceGroup.scalingOptions.desiredCount = request.desiredCount;
            await this.instanceGroupManager.upsertInstanceGroup(req.context, instanceGroup);
            this.instanceGroupManager.setAutoScaleGracePeriod(instanceGroup);
            res.status(200);
            res.send({ save: 'OK' });
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
        const lock: Redlock.Lock = await this.lockManager.lockAutoscaleProcessing(req.context);
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

        res.status(200);
        res.send({ instanceGroup });
    }

    async deleteInstanceGroup(req: Request, res: Response): Promise<void> {
        const lock: Redlock.Lock = await this.lockManager.lockAutoscaleProcessing(req.context);
        try {
            const instanceGroups = await this.instanceGroupManager.deleteInstanceGroup(req.context, req.params.name);

            res.status(200);
            res.send({ instanceGroups: instanceGroups });
        } finally {
            lock.unlock();
        }
    }

    async resetInstanceGroups(req: Request, res: Response): Promise<void> {
        const lock: Redlock.Lock = await this.lockManager.lockAutoscaleProcessing(req.context);
        try {
            await this.instanceGroupManager.resetInstanceGroups(req.context);

            res.status(200);
            res.send({ reset: 'OK' });
        } finally {
            lock.unlock();
        }
    }

    async launchProtectedInstanceGroup(req: Request, res: Response): Promise<void> {
        const lock: Redlock.Lock = await this.lockManager.lockAutoscaleProcessing(req.context);
        try {
            const requestBody = req.body;
            const groupName = req.params.name;
            const scaleDownProtectedTTL = requestBody.scaleDownProtectedTTLSec;
            req.context.logger.info('Protecting instances from scaling down', {
                groupName,
                scaleDownProtectedTTL,
            });

            const group = await this.instanceGroupManager.getInstanceGroup(groupName);

            if (requestBody.instanceConfigurationId != null) {
                group.instanceConfigurationId = requestBody.instanceConfigurationId;
            }
            group.scalingOptions.desiredCount = group.scalingOptions.desiredCount + requestBody.count;
            group.protectedTTLSec = requestBody.scaleDownProtectedTTLSec;

            await this.instanceGroupManager.upsertInstanceGroup(req.context, group);
            await this.instanceGroupManager.setAutoScaleGracePeriod(group);
            await this.instanceGroupManager.setScaleDownProtected(group);

            req.context.logger.info(
                `Newly launched instances in group ${groupName} will be protected for ${scaleDownProtectedTTL} seconds`,
            );

            res.status(200);
            res.send({ reset: 'OK' });
        } finally {
            lock.unlock();
        }
    }
}

export default Handlers;
