import { mock } from 'node:test';
import { Context } from '../context';
import { InstanceState } from '../instance_store';

export const mockStore = {
    fetchInstanceMetrics: mock.fn(() => [
        { value: 0.5, instanceId: 'i-0a1b2c3d4e5f6g7h8', timestamp: Date.now() - 350 },
    ]),
    cleanInstanceMetrics: mock.fn(),

    writeInstanceMetric: mock.fn(),

    fetchInstanceStates: mock.fn(() => []),
    filterOutAndTrimExpiredStates: mock.fn((ctx: Context, group: string, states: InstanceState[]) => states),

    getShutdownStatuses: mock.fn(() => [false]),
    getShutdownStatus: mock.fn(() => false),
    getShutdownConfirmation: mock.fn(() => false),
    getShutdownConfirmations: mock.fn(() => [false]),
};
