import { Request, Response } from 'express';
import { JibriTracker, JibriState } from './jibri_tracker';
import { InstanceStatus, InstanceDetails, StatsReport } from './instance_status';
import InstanceGroupManager, { InstanceGroup } from './instance_group';
import LockManager from './lock_manager';
import Redlock from 'redlock';

interface SidecarResponse {
    shutdown: boolean;
}

class Handlers {
    private jibriTracker: JibriTracker;
    private instanceStatus: InstanceStatus;
    private instanceGroupManager: InstanceGroupManager;
    private lockManager: LockManager;

    constructor(
        jibriTracker: JibriTracker,
        instanceStatus: InstanceStatus,
        instanceGroupManager: InstanceGroupManager,
        lockManager: LockManager,
    ) {
        this.jibriStateWebhook = this.jibriStateWebhook.bind(this);
        this.sidecarPoll = this.sidecarPoll.bind(this);

        this.lockManager = lockManager;
        this.jibriTracker = jibriTracker;
        this.instanceStatus = instanceStatus;
        this.instanceGroupManager = instanceGroupManager;
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

        await this.jibriTracker.track(status);
        res.sendStatus(200);
    }

    async sidecarPoll(req: Request, res: Response): Promise<void> {
        const details: InstanceDetails = req.body;
        const shutdownStatus = await this.instanceStatus.getShutdownStatus(details);

        const sendResponse: SidecarResponse = { shutdown: shutdownStatus };

        res.status(200);
        res.send(sendResponse);
    }

    async sidecarStats(req: Request, res: Response): Promise<void> {
        const report: StatsReport = req.body;
        await this.instanceStatus.stats(report);

        res.status(200);
        res.send({ save: 'OK' });
    }

    async upsertInstanceGroup(req: Request, res: Response): Promise<void> {
        const instanceGroup: InstanceGroup = req.body;
        if (instanceGroup.name != req.params.name) {
            res.status(400);
            res.send({ errors: ['The request param group name must match group name in the body'] });
            return;
        }
        const lock: Redlock.Lock = await this.lockManager.lockAutoscaleProcessing();
        try {
            await this.instanceGroupManager.upsertInstanceGroup(instanceGroup);
            this.instanceGroupManager.setAutoScaleGracePeriod(instanceGroup);
            res.status(200);
            res.send({ save: 'OK' });
        } finally {
            lock.unlock();
        }
    }

    async getInstanceGroups(req: Request, res: Response): Promise<void> {
        const instanceGroups = await this.instanceGroupManager.getAllInstanceGroups();

        res.status(200);
        res.send({ instanceGroups: instanceGroups });
    }

    async deleteInstanceGroup(req: Request, res: Response): Promise<void> {
        const lock: Redlock.Lock = await this.lockManager.lockAutoscaleProcessing();
        try {
            const instanceGroups = await this.instanceGroupManager.deleteInstanceGroup(req.params.name);

            res.status(200);
            res.send({ instanceGroups: instanceGroups });
        } finally {
            lock.unlock();
        }
    }

    async resetInstanceGroups(req: Request, res: Response): Promise<void> {
        const lock: Redlock.Lock = await this.lockManager.lockAutoscaleProcessing();
        try {
            await this.instanceGroupManager.resetInstanceGroups();

            res.status(200);
            res.send({ reset: 'OK' });
        } finally {
            lock.unlock();
        }
    }
}

export default Handlers;
