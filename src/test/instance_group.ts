/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck

import assert from 'node:assert';
import test, { afterEach, describe, mock } from 'node:test';

import { mockStore } from './mock_store';

import InstanceGroupManager from '../instance_group';

function log(msg, obj) {
    console.log(msg, JSON.stringify(obj));
}

function initContext(): Context {
    return {
        logger: {
            info: mock.fn(log),
            debug: mock.fn(log),
            error: mock.fn(log),
            warn: mock.fn(log),
        },
    };
}

describe('InstanceGroupManager', () => {
    let context = initContext();
    const group = {
        name: 'test',
        type: 'test',
        region: 'test',
        environment: 'test',
        cloud: 'test',
    };

    const instanceGroup = new InstanceGroupManager({
        instanceStore: mockStore,
        initialGroupList: [group],
        groupJobsCreationGracePeriod: 60,
        sanityJobsCreationGracePeriod: 60,
    });

    afterEach(() => {
        context = initContext();
    });

    test('get initial set', async () => {
        const groups = instanceGroup.getInitialGroups();
        assert.ok(groups, 'expect ok groups');
        assert.equal(groups.length, 1, 'expect groups to be 1');
        assert.deepEqual(groups[0], group, 'expect groups to be equal');
    });

    test('check for any existing groups', async () => {
        const res = await instanceGroup.existsAtLeastOneGroup(context);
        assert.ok(res, 'expect ok result');
    });

    test('set group as protected', async () => {
        const preCheck = await instanceGroup.isScaleDownProtected(context, group.name);
        assert.equal(preCheck, false, 'expect false result');

        const res = await instanceGroup.setScaleDownProtected(context, group);
        assert.ok(res, 'expect ok result');

        const postCheck = await instanceGroup.isScaleDownProtected(context, group.name);
        assert.ok(postCheck, 'expect group scale down protected');
    });
});
