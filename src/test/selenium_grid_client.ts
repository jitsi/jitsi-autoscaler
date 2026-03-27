/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck

import assert from 'node:assert';
import test, { afterEach, describe, mock } from 'node:test';

import SeleniumGridClient from '../selenium_grid_client';

describe('SeleniumGridClient', () => {
    const client = new SeleniumGridClient({ fetchTimeoutMs: 5000 });

    afterEach(() => {
        mock.restoreAll();
    });

    describe('parseGridResponse', () => {
        test('parses a standard Selenium Grid 4 status response', async () => {
            const gridResponse = {
                value: {
                    ready: true,
                    message: 'Selenium Grid ready.',
                    nodes: [
                        {
                            id: 'node-1',
                            slots: [{ session: { sessionId: 's1' } }, { session: null }],
                        },
                        {
                            id: 'node-2',
                            slots: [{ session: null }, { session: null }],
                        },
                    ],
                    sessionQueueRequests: ['req1', 'req2'],
                },
            };

            // Access the private method via prototype
            const status = SeleniumGridClient.prototype['parseGridResponse'].call(client, gridResponse);

            assert.strictEqual(status.nodeCount, 2);
            assert.strictEqual(status.maxSessions, 4);
            assert.strictEqual(status.activeSessions, 1);
            assert.strictEqual(status.sessionQueueSize, 2);
        });

        test('handles empty nodes array', async () => {
            const gridResponse = {
                value: {
                    ready: true,
                    nodes: [],
                    sessionQueueRequests: [],
                },
            };

            const status = SeleniumGridClient.prototype['parseGridResponse'].call(client, gridResponse);

            assert.strictEqual(status.nodeCount, 0);
            assert.strictEqual(status.maxSessions, 0);
            assert.strictEqual(status.activeSessions, 0);
            assert.strictEqual(status.sessionQueueSize, 0);
        });

        test('handles missing sessionQueueRequests', async () => {
            const gridResponse = {
                value: {
                    ready: true,
                    nodes: [
                        {
                            id: 'node-1',
                            slots: [{ session: null }],
                        },
                    ],
                },
            };

            const status = SeleniumGridClient.prototype['parseGridResponse'].call(client, gridResponse);

            assert.strictEqual(status.sessionQueueSize, 0);
            assert.strictEqual(status.nodeCount, 1);
        });

        test('throws on invalid response', async () => {
            assert.throws(() => {
                SeleniumGridClient.prototype['parseGridResponse'].call(client, {});
            }, /missing value field/);
        });
    });
});
