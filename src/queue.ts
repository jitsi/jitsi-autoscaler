import EventEmitter from 'node:events';

export class Job<T> {
    id: string;
    data: T;
    timeoutMs: number;
    retriesLeft: number;
    timer: NodeJS.Timeout;
    queue: Queue<T>;

    constructor(queue: Queue<T>, data: T) {
        this.queue = queue;
        this.data = data;
        this.timeoutMs = 30000;
        this.retriesLeft = 0;
    }

    timeout(timeoutMs: number): Job<T> {
        this.timeoutMs = timeoutMs;
        return this;
    }

    retries(count: number): Job<T> {
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

    async save(): Promise<Job<T>> {
        this.queue.push(this);
        return this;
    }
}

export interface DoneCallback<T> {
    (error: Error | null, result: T): void;
}

// this class is meant to implement a local queue with bee-queue behavior
export default class Queue<T> extends EventEmitter {
    private running = true;
    private queueName: string;
    private queue = <Job<T>[]>[];
    private jobProcessor: (job: Job<T>, done: DoneCallback<boolean>) => void;
    constructor(name = 'queue') {
        super();
        this.queueName = name;
    }

    async checkHealth(): Promise<{ waiting: number }> {
        return { waiting: this.queue.length };
    }

    process(callback: (job: Job<T>, done: DoneCallback<boolean>) => void): void {
        this.jobProcessor = callback;
    }

    createJob(data: T): Job<T> {
        return new Job(this, data);
    }

    push(job: Job<T>): void {
        this.queue.push(job);
    }

    pull(): Job<T> | undefined {
        return this.queue.shift();
    }

    shutdown(): void {
        this.running = false;
        this.queue = [];
    }

    async start(): Promise<void> {
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
