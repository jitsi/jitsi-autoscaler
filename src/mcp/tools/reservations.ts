import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AutoscalerApiClient, ReservationWithQueue } from '../api_client';
import { Reservation, ReservationStatus } from '../../reservation';
import { DESTRUCTIVE, NON_IDEMPOTENT_WRITE, READ_ONLY } from './annotations';

function formatReservation(r: Reservation | ReservationWithQueue): string {
    const lines = [
        `- **ID:** ${r.id}`,
        `- **Group:** ${r.groupName}`,
        `- **Node Count:** ${r.nodeCount}`,
        `- **Status:** ${r.status}`,
        `- **Created:** ${new Date(r.createdAt).toISOString()}`,
        `- **Expires:** ${new Date(r.expiresAt).toISOString()}`,
    ];
    if (r.fulfilledAt) {
        lines.push(`- **Fulfilled:** ${new Date(r.fulfilledAt).toISOString()}`);
    }
    const withQueue = r as ReservationWithQueue;
    if (withQueue.queuePosition != null) {
        lines.push(`- **Place in line:** ${withQueue.queuePosition} (${withQueue.aheadNodeCount ?? 0} nodes ahead)`);
    }
    return lines.join('\n');
}

export function registerCreateReservation(server: McpServer, client: AutoscalerApiClient): void {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore - ts-node hits zod recursion at default heap size
    server.tool(
        'create_reservation',
        'Reserve grid capacity for a job on a selenium-grid group. The reservation becomes "active" if it fits under maxDesired, otherwise "pending" (queued). Returns the reservation id used to poll, extend, or cancel it.',
        {
            name: z.string().describe('Name of the selenium-grid instance group'),
            nodeCount: z.number().int().min(1).describe('Number of grid nodes to reserve'),
            ttlSeconds: z
                .number()
                .int()
                .min(1)
                .optional()
                .describe('Time-to-live for the reservation in seconds (defaults to the server-configured TTL)'),
        },
        NON_IDEMPOTENT_WRITE,
        async ({ name, nodeCount, ttlSeconds }) => {
            try {
                const reservation = await client.createReservation(name, nodeCount, ttlSeconds);
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Reservation created on '${name}':\n${formatReservation(reservation)}`,
                        },
                    ],
                };
            } catch (error) {
                return {
                    content: [{ type: 'text', text: `Error creating reservation: ${(error as Error).message}` }],
                    isError: true,
                };
            }
        },
    );
}

export function registerListReservations(server: McpServer, client: AutoscalerApiClient): void {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore - ts-node hits zod recursion at default heap size
    server.tool(
        'list_reservations',
        'List reservations for a selenium-grid group, optionally filtered by status. Pending reservations include their place in line.',
        {
            name: z.string().describe('Name of the selenium-grid instance group'),
            status: z
                .array(z.nativeEnum(ReservationStatus))
                .optional()
                .describe('Filter by one or more statuses (pending, active, fulfilled, expired, cancelled)'),
        },
        READ_ONLY,
        async ({ name, status }) => {
            try {
                const reservations = await client.listReservations(name, status);
                if (reservations.length === 0) {
                    return {
                        content: [
                            {
                                type: 'text',
                                text: `No reservations found for '${name}'${
                                    status ? ` with status ${status.join(', ')}` : ''
                                }.`,
                            },
                        ],
                    };
                }
                const text = reservations.map((r) => formatReservation(r)).join('\n\n');
                return {
                    content: [
                        {
                            type: 'text',
                            text: `${reservations.length} reservation(s) for '${name}':\n\n${text}`,
                        },
                    ],
                };
            } catch (error) {
                return {
                    content: [{ type: 'text', text: `Error listing reservations: ${(error as Error).message}` }],
                    isError: true,
                };
            }
        },
    );
}

export function registerGetReservation(server: McpServer, client: AutoscalerApiClient): void {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore - ts-node hits zod recursion at default heap size
    server.tool(
        'get_reservation',
        'Get a single reservation by id, including its current status and (for pending reservations) place in line.',
        {
            name: z.string().describe('Name of the selenium-grid instance group'),
            id: z.string().describe('Reservation id'),
        },
        READ_ONLY,
        async ({ name, id }) => {
            try {
                const reservation = await client.getReservation(name, id);
                if (!reservation) {
                    return {
                        content: [{ type: 'text', text: `Reservation '${id}' not found on '${name}'.` }],
                        isError: true,
                    };
                }
                return {
                    content: [{ type: 'text', text: formatReservation(reservation) }],
                };
            } catch (error) {
                return {
                    content: [{ type: 'text', text: `Error getting reservation: ${(error as Error).message}` }],
                    isError: true,
                };
            }
        },
    );
}

export function registerExtendReservation(server: McpServer, client: AutoscalerApiClient): void {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore - ts-node hits zod recursion at default heap size
    server.tool(
        'extend_reservation',
        'Extend a non-terminal reservation by setting a new TTL from now. Use this to keep grid capacity reserved for a long-running job.',
        {
            name: z.string().describe('Name of the selenium-grid instance group'),
            id: z.string().describe('Reservation id'),
            ttlSeconds: z.number().int().min(1).describe('New time-to-live in seconds, measured from now'),
        },
        NON_IDEMPOTENT_WRITE,
        async ({ name, id, ttlSeconds }) => {
            try {
                const reservation = await client.extendReservation(name, id, ttlSeconds);
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Reservation '${id}' extended:\n${formatReservation(reservation)}`,
                        },
                    ],
                };
            } catch (error) {
                return {
                    content: [{ type: 'text', text: `Error extending reservation: ${(error as Error).message}` }],
                    isError: true,
                };
            }
        },
    );
}

export function registerCancelReservation(server: McpServer, client: AutoscalerApiClient): void {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore - ts-node hits zod recursion at default heap size
    server.tool(
        'cancel_reservation',
        'Cancel (release) a reservation, freeing its grid capacity. Call this when a job finishes so the grid can scale down or promote queued reservations.',
        {
            name: z.string().describe('Name of the selenium-grid instance group'),
            id: z.string().describe('Reservation id'),
        },
        DESTRUCTIVE,
        async ({ name, id }) => {
            try {
                const reservation = await client.cancelReservation(name, id);
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Reservation '${id}' cancelled:\n${formatReservation(reservation)}`,
                        },
                    ],
                };
            } catch (error) {
                return {
                    content: [{ type: 'text', text: `Error cancelling reservation: ${(error as Error).message}` }],
                    isError: true,
                };
            }
        },
    );
}
