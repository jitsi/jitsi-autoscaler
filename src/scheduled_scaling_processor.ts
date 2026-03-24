import { Context } from './context';
import InstanceGroupManager from './instance_group';
import { AutoscalerLock, AutoscalerLockManager } from './lock';
import Audit from './audit';
import { ScalingOptions, ScheduledScalingConfig, SchedulePeriod } from './instance_store';
import * as promClient from 'prom-client';

const scheduledScalingTransitionsCounter = new promClient.Counter({
    name: 'scheduled_scaling_transitions_total',
    help: 'Counter for scheduled scaling option transitions',
    labelNames: ['group'],
});

const scheduledScalingErrorsCounter = new promClient.Counter({
    name: 'scheduled_scaling_errors_total',
    help: 'Counter for scheduled scaling processing errors',
    labelNames: ['group'],
});

const scheduledScalingActivePeriodGauge = new promClient.Gauge({
    name: 'scheduled_scaling_active_period',
    help: 'Indicates the currently active scheduled scaling period (1=active, 0=inactive)',
    labelNames: ['group', 'period'],
});

const REGION_TIMEZONE_MAP: Record<string, string> = {
    'ap-mumbai-1': 'Asia/Kolkata',
    'ap-sydney-1': 'Australia/Sydney',
    'ap-tokyo-1': 'Asia/Tokyo',
    'eu-frankfurt-1': 'Europe/Berlin',
    'uk-london-1': 'Europe/London',
    'us-ashburn-1': 'America/New_York',
    'us-phoenix-1': 'America/Phoenix',
    'sa-saopaulo-1': 'America/Sao_Paulo',
    'me-jeddah-1': 'Asia/Riyadh',
    'ca-toronto-1': 'America/Toronto',
};

export interface ScheduledScalingProcessorOptions {
    instanceGroupManager: InstanceGroupManager;
    lockManager: AutoscalerLockManager;
    audit: Audit;
    defaultTimezone: string;
    enabled: boolean;
}

export default class ScheduledScalingProcessor {
    private instanceGroupManager: InstanceGroupManager;
    private lockManager: AutoscalerLockManager;
    private audit: Audit;
    private defaultTimezone: string;
    private enabled: boolean;

    constructor(options: ScheduledScalingProcessorOptions) {
        this.instanceGroupManager = options.instanceGroupManager;
        this.lockManager = options.lockManager;
        this.audit = options.audit;
        this.defaultTimezone = options.defaultTimezone;
        this.enabled = options.enabled;

        this.processScheduledScalingByGroup = this.processScheduledScalingByGroup.bind(this);
    }

    async processScheduledScalingByGroup(ctx: Context, groupName: string): Promise<boolean> {
        if (!this.enabled) {
            return false;
        }

        let lock: AutoscalerLock = undefined;
        try {
            lock = await this.lockManager.lockGroup(ctx, groupName);
        } catch (err) {
            ctx.logger.warn(`[ScheduledScaling] Error obtaining lock for processing`, { err });
            scheduledScalingErrorsCounter.inc({ group: groupName });
            return false;
        }

        try {
            const group = await this.instanceGroupManager.getInstanceGroup(ctx, groupName);
            if (!group) {
                ctx.logger.warn(`[ScheduledScaling] Group ${groupName} not found`);
                return false;
            }

            if (!group.scheduledScaling?.enabled) {
                return false;
            }

            const timezone = ScheduledScalingProcessor.resolveTimezone(
                group.scheduledScaling,
                group.region,
                this.defaultTimezone,
            );
            const now = new Date();
            const activePeriod = ScheduledScalingProcessor.findActivePeriod(group.scheduledScaling, now, timezone);

            // Update active period gauge
            for (const period of group.scheduledScaling.periods) {
                scheduledScalingActivePeriodGauge.set({ group: groupName, period: period.name }, 0);
            }
            scheduledScalingActivePeriodGauge.set({ group: groupName, period: activePeriod?.name ?? 'none' }, 1);
            if (activePeriod) {
                scheduledScalingActivePeriodGauge.set({ group: groupName, period: 'none' }, 0);
            }

            const currentPeriodName = group.scheduledScalingActivePeriod;
            const newPeriodName = activePeriod?.name;

            // No boundary crossed — same period (or still no period)
            if (currentPeriodName === newPeriodName) {
                ctx.logger.debug(`[ScheduledScaling] No boundary crossed for group ${groupName}`, {
                    activePeriod: newPeriodName ?? 'none',
                });
                return false;
            }

            const oldOptions = group.scalingOptions;
            let newOptions: ScalingOptions;

            if (activePeriod) {
                // Entering a period or switching periods
                if (!group.scheduledScalingBaseOptions) {
                    // First period entry — snapshot current options as baseline
                    group.scheduledScalingBaseOptions = { ...group.scalingOptions };
                }
                // Always merge period overrides onto the baseline
                newOptions = ScheduledScalingProcessor.applyInvariants({
                    ...group.scheduledScalingBaseOptions,
                    ...activePeriod.scalingOptions,
                });
                if (newOptions.desiredCount === 0) {
                    ctx.logger.warn(
                        `[ScheduledScaling] Period "${activePeriod.name}" resolves to desiredCount=0 for group ${groupName}`,
                        { newOptions },
                    );
                }
                group.scheduledScalingActivePeriod = activePeriod.name;
            } else {
                // Exiting all periods — restore baseline
                if (group.scheduledScalingBaseOptions) {
                    newOptions = { ...group.scheduledScalingBaseOptions };
                } else {
                    // No baseline to restore (shouldn't happen, but be safe)
                    ctx.logger.warn(
                        `[ScheduledScaling] Period ended for group ${groupName} but no baseOptions to restore`,
                    );
                    return false;
                }
                delete group.scheduledScalingActivePeriod;
                delete group.scheduledScalingBaseOptions;
            }

            ctx.logger.info(`[ScheduledScaling] Boundary crossed for group ${groupName}`, {
                from: currentPeriodName ?? 'none',
                to: newPeriodName ?? 'none',
                oldOptions,
                newOptions,
            });

            scheduledScalingTransitionsCounter.inc({ group: groupName });
            await this.audit.saveAutoScalerActionItem(groupName, {
                timestamp: Date.now(),
                actionType: 'scheduledScalingTransition',
                count: 0,
                oldDesiredCount: oldOptions.desiredCount,
                newDesiredCount: newOptions.desiredCount,
                scaleMetrics: [],
                detail: {
                    fromPeriod: currentPeriodName ?? 'none',
                    toPeriod: newPeriodName ?? 'none',
                    oldOptions,
                    newOptions,
                },
            });

            group.scalingOptions = newOptions;
            await this.instanceGroupManager.upsertInstanceGroup(ctx, group);
            await this.instanceGroupManager.setAutoScaleGracePeriod(ctx, group);
        } finally {
            await lock.release(ctx);
        }

        return true;
    }

    static resolveTimezone(config: ScheduledScalingConfig, region: string, defaultTimezone: string): string {
        return config.timezone ?? REGION_TIMEZONE_MAP[region] ?? defaultTimezone;
    }

    static getLocalTime(now: Date, timezone: string): { dayOfWeek: number; hour: number; minute: number } {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: timezone,
            weekday: 'short',
            hour: 'numeric',
            minute: 'numeric',
            hourCycle: 'h23',
        }).formatToParts(now);

        const weekdayStr = parts.find((p) => p.type === 'weekday')?.value;
        const hourStr = parts.find((p) => p.type === 'hour')?.value;
        const minuteStr = parts.find((p) => p.type === 'minute')?.value;

        const dayMap: Record<string, number> = {
            Sun: 0,
            Mon: 1,
            Tue: 2,
            Wed: 3,
            Thu: 4,
            Fri: 5,
            Sat: 6,
        };

        return {
            dayOfWeek: dayMap[weekdayStr] ?? 0,
            hour: parseInt(hourStr, 10),
            minute: parseInt(minuteStr, 10),
        };
    }

    static isTimeInRange(
        hour: number,
        minute: number,
        startHour: number,
        startMinute: number,
        endHour: number,
        endMinute: number,
    ): boolean {
        const current = hour * 60 + minute;
        const start = startHour * 60 + startMinute;
        const end = endHour * 60 + endMinute;
        if (start === end) {
            // e.g., 0:00-0:00 means all 24 hours
            return true;
        }
        if (end > start) {
            // Normal range, e.g., 8:00-20:00
            return current >= start && current < end;
        }
        // Wraps midnight, e.g., 22:00-6:00
        return current >= start || current < end;
    }

    static findActivePeriod(config: ScheduledScalingConfig, now: Date, timezone: string): SchedulePeriod | null {
        const { dayOfWeek, hour, minute } = ScheduledScalingProcessor.getLocalTime(now, timezone);
        const yesterdayDayOfWeek = (dayOfWeek + 6) % 7;
        const currentMin = hour * 60 + minute;

        const matchingPeriods = config.periods.filter((period) => {
            const startMin = period.startHour * 60 + (period.startMinute ?? 0);
            const endMin = period.endHour * 60 + (period.endMinute ?? 0);
            const wraps = startMin !== endMin && endMin < startMin;

            // Same-day match: period's dayOfWeek includes today and time is in range.
            // For wrapping periods, only match the pre-midnight side here.
            if (period.dayOfWeek.includes(dayOfWeek)) {
                if (
                    ScheduledScalingProcessor.isTimeInRange(
                        hour,
                        minute,
                        period.startHour,
                        period.startMinute ?? 0,
                        period.endHour,
                        period.endMinute ?? 0,
                    )
                ) {
                    if (!wraps || currentMin >= startMin) {
                        return true;
                    }
                }
            }

            // Yesterday match: period wraps midnight, started yesterday, and we're
            // in the post-midnight portion (currentMin < endMin).
            if (wraps && period.dayOfWeek.includes(yesterdayDayOfWeek) && currentMin < endMin) {
                return true;
            }

            return false;
        });

        if (matchingPeriods.length === 0) {
            return null;
        }

        // Sort by priority descending, pick highest
        matchingPeriods.sort((a, b) => b.priority - a.priority);
        return matchingPeriods[0];
    }

    static applyInvariants(options: ScalingOptions): ScalingOptions {
        const resolved = { ...options };
        if (resolved.minDesired > resolved.desiredCount) {
            resolved.desiredCount = resolved.minDesired;
        }
        if (resolved.maxDesired < resolved.desiredCount) {
            resolved.maxDesired = resolved.desiredCount;
        }
        if (resolved.minDesired > resolved.maxDesired) {
            resolved.minDesired = resolved.maxDesired;
        }
        return resolved;
    }

    static resolveActiveScalingOptions(
        config: ScheduledScalingConfig,
        baseOptions: ScalingOptions,
        now: Date,
        timezone: string,
    ): ScalingOptions | null {
        const activePeriod = ScheduledScalingProcessor.findActivePeriod(config, now, timezone);

        if (!activePeriod) {
            return null;
        }

        return ScheduledScalingProcessor.applyInvariants({ ...baseOptions, ...activePeriod.scalingOptions });
    }

    static scalingOptionsEqual(a: ScalingOptions, b: ScalingOptions): boolean {
        return (
            a.minDesired === b.minDesired &&
            a.maxDesired === b.maxDesired &&
            a.desiredCount === b.desiredCount &&
            a.scaleUpQuantity === b.scaleUpQuantity &&
            a.scaleDownQuantity === b.scaleDownQuantity &&
            a.scaleUpThreshold === b.scaleUpThreshold &&
            a.scaleDownThreshold === b.scaleDownThreshold &&
            a.scalePeriod === b.scalePeriod &&
            a.scaleUpPeriodsCount === b.scaleUpPeriodsCount &&
            a.scaleDownPeriodsCount === b.scaleDownPeriodsCount
        );
    }
}
