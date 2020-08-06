import { Request, Response } from 'express';
import { JibriTracker, JibriState } from './jibri_tracker';
import { InstanceStatus, InstanceDetails, StatsReport } from './instance_status';

interface SidecarResponse {
    shutdown: boolean;
}

class Handlers {
    private jibriTracker: JibriTracker;
    private instanceStatus: InstanceStatus;

    constructor(jibriTracker: JibriTracker, instanceStatus: InstanceStatus) {
        this.jibriStateWebhook = this.jibriStateWebhook.bind(this);
        this.sidecarPoll = this.sidecarPoll.bind(this);

        this.jibriTracker = jibriTracker;
        this.instanceStatus = instanceStatus;
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
}

export default Handlers;
