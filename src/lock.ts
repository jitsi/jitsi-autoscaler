import { Context } from './context';

export interface AutoscalerLock {
    release(): Promise<void>;
}

export interface AutoscalerLockManager {
    lockGroup(ctx: Context, group: string): Promise<AutoscalerLock>;
    lockJobCreation(ctx: Context): Promise<AutoscalerLock>;
}

export default AutoscalerLock;
