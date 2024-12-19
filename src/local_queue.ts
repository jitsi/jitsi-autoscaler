import EventEmitter from 'node:events';
import QueueProcessor, { QueueDoneCallback, QueueJob, QueueProvider } from './queue';

export class LocalQueueProvider implements QueueProvider {
    createQueue<T>(name: string): QueueProcessor<T> {
        return new LocalQueue(name);
    }
}

export class LocalJob<T> extends EventEmitter implements QueueJob {
    id: string;
    data: T;
    timeoutMs: number;
    retriesLeft: number;
    timer: NodeJS.Timeout;
    queue: LocalQueue<T>;

    constructor(queue: LocalQueue<T>, data: T) {
        super();
        this.queue = queue;
        this.data = data;
        this.timeoutMs = 30000;
        this.retriesLeft = 0;
    }

    timeout(timeoutMs: number): this {
        this.timeoutMs = timeoutMs;
        return this;
    }

    retries(count: number): this {
        this.retriesLeft = count;
        return this;
    }

    startTimer(): Promise<void> {
        return new Promise((_resolve, reject) => {
            this.timer = setTimeout(reject, this.timeoutMs);
        });
    }

    stopTimer(): void {
        if (this.timer) clearTimeout(this.timer);
    }

    async save(): Promise<this> {
        this.queue.push(this);
        return this;
    }
}

// this class is meant to implement a local queue with bee-queue behavior

// prettier-ignore
export default class LocalQueue<T = any> extends EventEmitter implements QueueProcessor<T> { // eslint-disable-line @typescript-eslint/no-explicit-any
    private running = true;
    private queueName: string;
    private queue = <LocalJob<T>[]>[];
    private jobProcessor: (job: LocalJob<T>, done: QueueDoneCallback<boolean>) => void;
    constructor(name = 'queue') {
        super();
        this.queueName = name;
    }

    async checkHealth(): Promise<{ waiting: number }> {
        return { waiting: this.queue.length };
    }

    process(callback: (job: LocalJob<T>, done: QueueDoneCallback<boolean>) => void): void {
        this.jobProcessor = callback;
    }

    createJob<U extends T>(data: U): QueueJob<U> {
        return <LocalJob<U>>new LocalJob(this, data);
    }

    push(job: LocalJob<T>): void {
        this.queue.push(job);
    }

    pull(): LocalJob<T> | undefined {
        return this.queue.shift();
    }

    shutdown(): void {
        this.running = false;
        this.queue = [];
    }

    start(): void {
        this._run();
    }

    async _run(): Promise<void> {
        while (this.running) {
            const job = this.pull();
            if (job) {
                // start a new time alongside the job
                const p = <Promise<void>[]>[];
                p.push(job.startTimer());
                p.push(
                    new Promise((resolve, reject) => {
                        try {
                            this.jobProcessor(job, (err, result) => {
                                job.stopTimer();
                                if (err) {
                                    if (job.retriesLeft > 0) {
                                        this.emit('job retrying', job.id, err);
                                        job.retries(job.retriesLeft - 1);
                                        job.save();
                                    } else {
                                        this.emit('failed', [job, err]);
                                    }
                                } else {
                                    this.emit('job succeeded', job.id, result);
                                }
                                resolve();
                            });
                        } catch (err) {
                            reject(err);
                        }
                    }),
                );

                await Promise.all(p);
            } else {
                this.emit('idle');
                await new Promise((resolve) => setTimeout(resolve, 1000));
            }
        }
    }
}
