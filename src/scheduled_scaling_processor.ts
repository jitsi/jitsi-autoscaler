import { Context } from './context';
import InstanceGroupManager from './instance_group';
import { AutoscalerLock, AutoscalerLockManager } from './lock';
import Audit from './audit';
import { ScalingOptions, ScheduledScalingConfig, SchedulePeriod } from './instance_store';

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
            const targetOptions = ScheduledScalingProcessor.resolveActiveScalingOptions(
                group.scheduledScaling,
                new Date(),
                timezone,
            );

            if (ScheduledScalingProcessor.scalingOptionsEqual(group.scalingOptions, targetOptions)) {
                ctx.logger.debug(`[ScheduledScaling] No changes needed for group ${groupName}`);
                return false;
            }

            ctx.logger.info(`[ScheduledScaling] Updating scaling options for group ${groupName}`, {
                oldOptions: group.scalingOptions,
                newOptions: targetOptions,
            });

            group.scalingOptions = targetOptions;
            // Disable external scheduler when internal scheduling is active
            group.enableScheduler = false;
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

    static getLocalTime(now: Date, timezone: string): { dayOfWeek: number; hour: number } {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: timezone,
            weekday: 'short',
            hour: 'numeric',
            hourCycle: 'h23',
        }).formatToParts(now);

        const weekdayStr = parts.find((p) => p.type === 'weekday')?.value;
        const hourStr = parts.find((p) => p.type === 'hour')?.value;

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
        };
    }

    static isHourInRange(hour: number, startHour: number, endHour: number): boolean {
        if (startHour === endHour) {
            // startHour=0, endHour=0 means all 24 hours
            return true;
        }
        if (endHour > startHour) {
            // Normal range, e.g., 8-20
            return hour >= startHour && hour < endHour;
        }
        // Wraps midnight, e.g., 22-6 means 22,23,0,1,2,3,4,5
        return hour >= startHour || hour < endHour;
    }

    static findActivePeriod(config: ScheduledScalingConfig, now: Date, timezone: string): SchedulePeriod | null {
        const { dayOfWeek, hour } = ScheduledScalingProcessor.getLocalTime(now, timezone);

        const matchingPeriods = config.periods.filter(
            (period) =>
                period.dayOfWeek.includes(dayOfWeek) &&
                ScheduledScalingProcessor.isHourInRange(hour, period.startHour, period.endHour),
        );

        if (matchingPeriods.length === 0) {
            return null;
        }

        // Sort by priority descending, pick highest
        matchingPeriods.sort((a, b) => b.priority - a.priority);
        return matchingPeriods[0];
    }

    static resolveActiveScalingOptions(config: ScheduledScalingConfig, now: Date, timezone: string): ScalingOptions {
        const activePeriod = ScheduledScalingProcessor.findActivePeriod(config, now, timezone);

        let resolved: ScalingOptions;
        if (activePeriod) {
            resolved = { ...config.baseScalingOptions, ...activePeriod.scalingOptions };
        } else {
            resolved = { ...config.baseScalingOptions };
        }

        // Enforce safety invariants
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
