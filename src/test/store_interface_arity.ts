/**
 * Compile-time guard against interface/implementation signature drift (Workstream 5.1 of the storage
 * remediation). TypeScript's parameter bivariance lets an implementation declare FEWER parameters than
 * its interface and still compile, which is exactly how RedisStore.getShutdownConfirmation(ctx, id)
 * satisfied InstanceStore.getShutdownConfirmation(ctx, group, id) while silently misreading the group
 * as the instance ID (R2). The types below reject any implementation method whose parameter count does
 * not cover the interface's, so the build (ts-node type-checks this file when the suite runs) fails on
 * the next such drift instead of a production read path.
 *
 * This file intentionally has NO `@ts-nocheck`: the assertions are types, not runtime checks.
 */
import assert from 'node:assert';
import test from 'node:test';

import RedisStore from '../redis';
import ConsulStore from '../consul';
import PrometheusClient from '../prometheus';
import InstanceStore from '../instance_store';
import MetricsStore from '../metrics_store';
import ReservationStore from '../reservation_store';
import { Context } from '../context';

// `true` when Iface's member K is optional (`m?: ...`). Uses Pick rather than `undefined extends Iface[K]`
// because strictNullChecks is off in this project, so optionality never shows up in the member's type.
type IsOptionalMember<Iface, K extends keyof Iface> = object extends Pick<Iface, K> ? true : false;

// For every method on Iface: `true` when Impl has a method of the same name whose parameter-count type
// covers the interface's (an implementation may add optional/defaulted params, never drop required ones).
// An optional interface method (e.g. InstanceStore.fetchInstanceStatesWithShutdownStatuses) may be absent
// from an implementation, but when present it is arity-checked like any other.
type SameArity<Impl, Iface> = {
    [K in keyof Iface]: Iface[K] extends (...a: infer A) => unknown
        ? K extends keyof Impl
            ? Impl[K] extends (...b: infer B) => unknown
                ? A['length'] extends B['length']
                    ? true
                    : false
                : false
            : IsOptionalMember<Iface, K>
        : true;
};
// Collapses the per-method map to `true` only when every entry is `true`; otherwise `never`, so the
// `= true` initializers below fail to type-check and name the offending store.
type AllTrue<T> = T[keyof T] extends true ? true : never;

const redisImplementsInstanceStore: AllTrue<SameArity<RedisStore, InstanceStore>> = true;
const redisImplementsMetricsStore: AllTrue<SameArity<RedisStore, MetricsStore>> = true;
const redisImplementsReservationStore: AllTrue<SameArity<RedisStore, ReservationStore>> = true;
const consulImplementsInstanceStore: AllTrue<SameArity<ConsulStore, InstanceStore>> = true;
const consulImplementsReservationStore: AllTrue<SameArity<ConsulStore, ReservationStore>> = true;
const prometheusImplementsMetricsStore: AllTrue<SameArity<PrometheusClient, MetricsStore>> = true;

// Self-check: the guard must reject the exact drift that caused R2 (a 2-arg getShutdownConfirmation).
// `@ts-expect-error` fails compilation if the line below does NOT error, so this line proves the guard bites.
type DriftedStore = { getShutdownConfirmation(ctx: Context, instanceId: string): Promise<false | string> };
// @ts-expect-error a 2-parameter implementation of a 3-parameter interface method must be rejected
const driftIsRejected: AllTrue<SameArity<DriftedStore, Pick<InstanceStore, 'getShutdownConfirmation'>>> = true;

// Self-checks for optional members: an implementation may omit one, but an implemented one with too few
// parameters is still rejected, and a REQUIRED member may never be omitted.
type OptionalIface = { maybe?(ctx: Context, group: string): Promise<void> };
type RequiredIface = { must(ctx: Context, group: string): Promise<void> };
const omittedOptionalIsAccepted: AllTrue<SameArity<{ unrelated(): void }, OptionalIface>> = true;
// @ts-expect-error an implemented optional method with fewer parameters than the interface must be rejected
const driftedOptionalIsRejected: AllTrue<SameArity<{ maybe(ctx: Context): Promise<void> }, OptionalIface>> = true;
// @ts-expect-error a missing required method must be rejected
const omittedRequiredIsRejected: AllTrue<SameArity<{ unrelated(): void }, RequiredIface>> = true;

test('store implementations match their interface arity (enforced at compile time)', () => {
    assert.ok(redisImplementsInstanceStore);
    assert.ok(redisImplementsMetricsStore);
    assert.ok(redisImplementsReservationStore);
    assert.ok(consulImplementsInstanceStore);
    assert.ok(consulImplementsReservationStore);
    assert.ok(prometheusImplementsMetricsStore);
    assert.ok(driftIsRejected);
    assert.ok(omittedOptionalIsAccepted);
    assert.ok(driftedOptionalIsRejected);
    assert.ok(omittedRequiredIsRejected);
});
