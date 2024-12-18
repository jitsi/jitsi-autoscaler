import EventEmitter from 'node:events';

export interface QueueDoneCallback<T> {
    (error: Error | null, result: T): void;
}

// prettier-ignore
export default interface QueueProcessor<T = any> extends EventEmitter { // eslint-disable-line @typescript-eslint/no-explicit-any
    process(callback: (job: QueueJob<T>, done: QueueDoneCallback<boolean>) => void): void;
    createJob<U extends T>(data: U): QueueJob<U>;
    checkHealth(): Promise<{ waiting: number }>;

    start(): void;

    on(ev: 'ready', fn: () => void): this;
    on(ev: 'error', fn: (err: Error) => void): this;
    on(ev: 'succeeded', fn: (job: QueueJob<T>, result: any) => void): this; // eslint-disable-line @typescript-eslint/no-explicit-any
    on(ev: 'retrying', fn: (job: QueueJob<T>, err: Error) => void): this;
    on(ev: 'failed', fn: (job: QueueJob<T>, err: Error) => void): this;
    on(ev: 'stalled', fn: (jobId: string) => void): this;
  
    on(ev: 'job succeeded', fn: (jobId: string, result: any) => void): this; // eslint-disable-line @typescript-eslint/no-explicit-any
    on(ev: 'job retrying', fn: (jobId: string, err: Error) => void): this;
    on(ev: 'job failed', fn: (jobId: string, err: Error) => void): this;
    on(ev: 'job progress', fn: (jobId: string, progress: any) => void): this; // eslint-disable-line @typescript-eslint/no-explicit-any

}

export interface QueueProvider {
    createQueue<T>(name: string): QueueProcessor<T>;
}

// prettier-ignore
export interface QueueJob<T = any> extends EventEmitter { // eslint-disable-line @typescript-eslint/no-explicit-any
    id: string;
    data: T;
    save(): Promise<this>;
    timeout(ms: number): this;
    retries(n: number): this;
}
