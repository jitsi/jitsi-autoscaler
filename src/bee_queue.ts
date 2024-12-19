import Queue from 'bee-queue';
import QueueProcessor, { QueueProvider } from './queue';
import { ClientOpts } from 'redis';

export class BeeQueueProvider implements QueueProvider {
    private redisClientOptions: ClientOpts;
    constructor(redisClientOptions: ClientOpts) {
        this.redisClientOptions = redisClientOptions;
    }

    createQueue<T>(queueName: string): QueueProcessor<T> {
        return new BeeQueueWrapper(queueName, {
            redis: this.redisClientOptions,
            removeOnSuccess: true,
            removeOnFailure: true,
        });
    }
}

class BeeQueueWrapper<T> extends Queue<T> {
    start(): void {
        // no-op
    }
}
