/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck

import { mock } from 'node:test';
import { Context } from '../context';
import { InstanceState } from '../instance_store';

const _values = {};

// mockStore mirrors the full MetricsStore + InstanceStore + ReservationStore surface so tests that
// treat it as an InstanceStore hit the same method arity as the real stores. Keep signatures aligned
// with instance_store.ts / metrics_store.ts (the cross-provider store_contract.ts test is the real guard).
export const mockStore = {
    // metrics
    fetchInstanceMetrics: mock.fn((_ctx: Context, _group: string, _windowSeconds?: number) => [
        { value: 0.5, instanceId: 'i-0a1b2c3d4e5f6g7h8', timestamp: Date.now() - 350 },
    ]),
    cleanInstanceMetrics: mock.fn(() => true),
    writeInstanceMetric: mock.fn(() => true),
    saveMetricUnTrackedCount: mock.fn(() => true),

    // instance states
    fetchInstanceStates: mock.fn(() => []),
    saveInstanceStatus: mock.fn(() => true),
    filterOutAndTrimExpiredStates: mock.fn((_ctx: Context, _group: string, states: InstanceState[]) => states),

    // shutdown
    setShutdownStatus: mock.fn(() => true),
    getShutdownStatuses: mock.fn(() => [false]),
    getShutdownConfirmations: mock.fn(() => [false]),
    getShutdownStatus: mock.fn((_ctx: Context, _group: string, _instanceId: string) => false),
    getShutdownConfirmation: mock.fn((_ctx: Context, _group: string, _instanceId: string) => false),
    setShutdownConfirmation: mock.fn(() => true),
    setScaleDownProtected: mock.fn(() => true),
    areScaleDownProtected: mock.fn((_ctx, _group, input) => {
        return input.map(() => false);
    }),

    // reconfigure
    setReconfigureDate: mock.fn(() => true),
    unsetReconfigureDate: mock.fn(() => true),
    getReconfigureDates: mock.fn((_ctx, _group, input) => input.map(() => '')),
    getReconfigureDate: mock.fn((_ctx: Context, _group: string, _instanceId: string) => ''),

    // groups
    existsAtLeastOneGroup: mock.fn(() => true),
    upsertInstanceGroup: mock.fn(() => true),
    getInstanceGroup: mock.fn(() => null),
    getAllInstanceGroups: mock.fn(() => []),
    getAllInstanceGroupNames: mock.fn(() => []),
    deleteInstanceGroup: mock.fn(() => undefined),

    // key/value
    setValue: mock.fn((_ctx: Context, key: string, value: string, ttl: number) => {
        _values[key] = { value, ttl: Date.now() + ttl * 1000 };
        return Promise.resolve(true);
    }),
    checkValue: mock.fn((_ctx, key) => {
        if (_values[key]) {
            return Promise.resolve(true);
        }
        return Promise.resolve(false);
    }),

    // sanity + health
    saveCloudInstances: mock.fn(() => true),
    ping: mock.fn(() => true),
};
