import { Request, Response } from 'express';
import { JibriTracker, JibriState } from './jibri_tracker';

class Handlers {
    private jibriTracker: JibriTracker;

    constructor(jibriTracker: JibriTracker) {
        this.jibriStateWebhook = this.jibriStateWebhook.bind(this);

        this.jibriTracker = jibriTracker;
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
}

export default Handlers;
