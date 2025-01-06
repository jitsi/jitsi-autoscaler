/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck

import { mock } from 'node:test';
import { Context } from '../context';
import { InstanceState } from '../instance_store';

const _values = {};

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

    setScaleDownProtected: mock.fn(() => true),
    areScaleDownProtected: mock.fn((_ctx, _group, input) => {
        return input.map(() => false);
    }),

    existsAtLeastOneGroup: mock.fn(() => true),
    upsertInstanceGroup: mock.fn(() => true),

    setValue: mock.fn((ctx: Context, key: string, value: string, ttl: number) => {
        _values[key] = { value, ttl: Date.now() + ttl * 1000 };
        return Promise.resolve(true);
    }),

    checkValue: mock.fn((_ctx, key) => {
        if (_values[key]) {
            return Promise.resolve(true);
        }
        return Promise.resolve(false);
    }),
};
