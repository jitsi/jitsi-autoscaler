# Scheduled Scaling Feature

Scheduled scaling allows instance groups to automatically adjust their scaling parameters based on time of day and day of week. This enables pre-warming capacity before daily peak hours and scaling down during off-peak times and weekends.

## Concepts

### How It Works

Each group can have a `scheduledScaling` configuration containing:

1. **Base scaling options** — the default scaling parameters used during off-peak/unscheduled times.
2. **Periods** — named time windows (e.g., "weekday-peak", "weekend") that override specific base parameters when active.
3. **Timezone** — either explicitly set or auto-derived from the group's cloud region.

Every ~30 seconds, the scheduler evaluates which period is active for each group and applies the corresponding scaling options. The autoscaler then operates within whatever envelope the scheduler has set.

### Timezone Resolution

The timezone is resolved in priority order:

1. `scheduledScaling.timezone` — explicit IANA timezone string on the config (e.g., `"Asia/Tokyo"`)
2. Region mapping — auto-derived from the group's `region` field
3. System default — the `SCHEDULED_SCALING_DEFAULT_TIMEZONE` environment variable (defaults to `"UTC"`)

Region-to-timezone mapping:

| Region | Timezone |
|--------|----------|
| `ap-mumbai-1` | `Asia/Kolkata` |
| `ap-sydney-1` | `Australia/Sydney` |
| `ap-tokyo-1` | `Asia/Tokyo` |
| `eu-frankfurt-1` | `Europe/Berlin` |
| `uk-london-1` | `Europe/London` |
| `us-ashburn-1` | `America/New_York` |
| `us-phoenix-1` | `America/Phoenix` |
| `sa-saopaulo-1` | `America/Sao_Paulo` |
| `me-jeddah-1` | `Asia/Riyadh` |
| `ca-toronto-1` | `America/Toronto` |

### Period Matching

A period is active when:
- The current local day-of-week (0=Sunday through 6=Saturday) is in the period's `dayOfWeek` array, AND
- The current local hour (0-23) falls within the `[startHour, endHour)` range.

When multiple periods match simultaneously, the one with the highest `priority` value wins.

### Hour Ranges

- **Normal range**: `startHour < endHour` — e.g., `startHour: 8, endHour: 20` means 8:00 AM to 7:59 PM.
- **Midnight wrap**: `startHour > endHour` — e.g., `startHour: 22, endHour: 6` means 10:00 PM to 5:59 AM (crosses midnight).
- **All day**: `startHour === endHour` (typically `0, 0`) — matches all 24 hours.

### Scale-Down Inhibiting

When a period has `inhibitScaleDown: true`, the autoscaler will not reduce `desiredCount` during that period, even if metrics indicate low utilization. This prevents pre-warmed capacity from being scaled down before load arrives.

For strongest protection, combine `inhibitScaleDown: true` with a `minDesired` equal to the `desiredCount` in the period's scaling options.

### Interaction with External Scheduler

When `scheduledScaling.enabled` is set to `true`, the group's `enableScheduler` flag is automatically set to `false`, disabling the external `PUT /groups/options/full-scaling` API for that group. The two scheduling systems are mutually exclusive.

## Data Model

### ScheduledScalingConfig

Stored on `InstanceGroup.scheduledScaling` (optional).

```typescript
interface ScheduledScalingConfig {
    enabled: boolean;
    timezone?: string;              // optional IANA timezone override
    baseScalingOptions: ScalingOptions;
    periods: SchedulePeriod[];
}
```

### SchedulePeriod

```typescript
interface SchedulePeriod {
    name: string;                   // human-readable label, e.g., "weekday-peak"
    dayOfWeek: number[];            // 0=Sunday, 1=Monday, ..., 6=Saturday
    startHour: number;              // 0-23, inclusive
    endHour: number;                // 0-23, exclusive (wraps midnight if <= startHour)
    priority: number;               // higher number wins when periods overlap
    scalingOptions: Partial<ScalingOptions>;  // only overridden fields needed
    inhibitScaleDown?: boolean;     // if true, prevents autoscaler scale-down during this period
}
```

### ScalingOptions

The full set of fields that `baseScalingOptions` must provide and that period overrides can partially replace:

```typescript
interface ScalingOptions {
    minDesired: number;
    maxDesired: number;
    desiredCount: number;
    scaleUpQuantity: number;
    scaleDownQuantity: number;
    scaleUpThreshold: number;
    scaleDownThreshold: number;
    scalePeriod: number;
    scaleUpPeriodsCount: number;
    scaleDownPeriodsCount: number;
}
```

## API Endpoints

All endpoints are authenticated via ASAP JWT (same as existing group endpoints). The base URL path is relative to the autoscaler service.

### GET /groups/:name/scheduled-scaling

Returns the current scheduled scaling configuration and the currently active period.

**Response 200:**

```json
{
    "scheduledScaling": {
        "enabled": true,
        "timezone": "America/New_York",
        "baseScalingOptions": {
            "minDesired": 1,
            "maxDesired": 5,
            "desiredCount": 2,
            "scaleUpQuantity": 1,
            "scaleDownQuantity": 1,
            "scaleUpThreshold": 0.8,
            "scaleDownThreshold": 0.3,
            "scalePeriod": 60,
            "scaleUpPeriodsCount": 2,
            "scaleDownPeriodsCount": 4
        },
        "periods": [
            {
                "name": "weekday-peak",
                "dayOfWeek": [1, 2, 3, 4, 5],
                "startHour": 8,
                "endHour": 20,
                "priority": 10,
                "inhibitScaleDown": true,
                "scalingOptions": {
                    "minDesired": 10,
                    "maxDesired": 20,
                    "desiredCount": 10
                }
            },
            {
                "name": "weekend",
                "dayOfWeek": [0, 6],
                "startHour": 0,
                "endHour": 0,
                "priority": 20,
                "scalingOptions": {
                    "minDesired": 0,
                    "maxDesired": 2,
                    "desiredCount": 1
                }
            }
        ]
    },
    "activePeriod": {
        "name": "weekday-peak",
        "dayOfWeek": [1, 2, 3, 4, 5],
        "startHour": 8,
        "endHour": 20,
        "priority": 10,
        "inhibitScaleDown": true,
        "scalingOptions": {
            "minDesired": 10,
            "maxDesired": 20,
            "desiredCount": 10
        }
    },
    "resolvedTimezone": "America/New_York"
}
```

When no scheduled scaling is configured:

```json
{
    "scheduledScaling": null,
    "activePeriod": null
}
```

**Response 404:** Group not found.

### PUT /groups/:name/scheduled-scaling

Creates or replaces the entire scheduled scaling configuration for a group. Takes effect immediately — the active period's scaling options are applied on save.

**Request body:** A full `ScheduledScalingConfig` object.

```json
{
    "enabled": true,
    "baseScalingOptions": {
        "minDesired": 1,
        "maxDesired": 5,
        "desiredCount": 2,
        "scaleUpQuantity": 1,
        "scaleDownQuantity": 1,
        "scaleUpThreshold": 0.8,
        "scaleDownThreshold": 0.3,
        "scalePeriod": 60,
        "scaleUpPeriodsCount": 2,
        "scaleDownPeriodsCount": 4
    },
    "periods": [
        {
            "name": "weekday-peak",
            "dayOfWeek": [1, 2, 3, 4, 5],
            "startHour": 8,
            "endHour": 20,
            "priority": 10,
            "inhibitScaleDown": true,
            "scalingOptions": {
                "minDesired": 10,
                "maxDesired": 20,
                "desiredCount": 10
            }
        }
    ]
}
```

**Response 200:** `{ "save": "OK" }`

**Response 400:** Invalid timezone string.

**Response 404:** Group not found.

**Side effects:**
- Sets `enableScheduler = false` on the group when `enabled` is `true`.
- Immediately resolves and applies the active period's scaling options to the group.
- Sets an autoscale grace period to prevent the autoscaler from immediately counteracting the change.

### DELETE /groups/:name/scheduled-scaling

Removes the scheduled scaling configuration entirely. The group's current `scalingOptions` remain as-is (whatever the last active period set). Manual scaling or external scheduling can be re-enabled afterward.

**Response 200:** `{ "save": "OK" }`

**Response 404:** Group not found.

## UI Design Guidance

### Reading the Current State

To populate the UI for a group's scheduled scaling:

1. `GET /groups/:name` — gives you the full group including `scheduledScaling` (if configured), `region`, and current `scalingOptions`.
2. `GET /groups/:name/scheduled-scaling` — gives you the config plus `activePeriod` (which period is currently in effect, or `null`) and `resolvedTimezone`.

### Key UI Components

**Enable/Disable Toggle**: Controls `scheduledScaling.enabled`. When toggling off, you may want to call `DELETE` to remove the config entirely, or just `PUT` with `enabled: false` to preserve the configuration for later re-enablement.

**Timezone Display**: Show the `resolvedTimezone` from the GET response. If the user hasn't set an explicit timezone, show the auto-resolved one (derived from region) with a label like "Auto-detected from region". Allow override via the optional `timezone` field.

**Base Scaling Options Form**: The full `ScalingOptions` that apply during unscheduled times. All 10 fields are required. This is what the group falls back to when no period matches.

**Periods List/Table**: Each period needs:
- `name` — free-text label
- `dayOfWeek` — multi-select of days (Sunday through Saturday). Display as checkboxes or a weekly calendar strip.
- `startHour` / `endHour` — hour pickers (0-23). When `startHour === endHour`, display as "All day". When `startHour > endHour`, indicate the range wraps midnight.
- `priority` — integer. Higher wins. Consider defaulting to 10 for the first period and auto-incrementing, or let the user drag-to-reorder and derive priority from order.
- `inhibitScaleDown` — checkbox, labeled something like "Prevent scale-down during this period".
- `scalingOptions` — partial override form. Only show fields the user wants to override; omitted fields inherit from base. The most commonly overridden fields are `minDesired`, `maxDesired`, and `desiredCount`.

**Active Period Indicator**: Highlight which period (if any) is currently active. The `activePeriod` field from the GET response tells you this. If `null`, the base options are in effect.

**Weekly Timeline Visualization** (optional but recommended): A 7-day × 24-hour grid showing which period is active at each hour, color-coded by period name. This makes it easy to see coverage gaps and overlaps at a glance.

### Saving Changes

Always `PUT` the entire `ScheduledScalingConfig` as a single request. The API does not support partial updates — you must send the full config including all periods and base options.

### Validation Rules to Enforce Client-Side

- `baseScalingOptions` must have all 10 `ScalingOptions` fields, all non-negative.
- `baseScalingOptions.minDesired <= baseScalingOptions.desiredCount <= baseScalingOptions.maxDesired`.
- Each period must have a non-empty `name`, at least one day in `dayOfWeek`, `startHour` and `endHour` in range 0-23, and a numeric `priority`.
- Period `scalingOptions` fields are all optional, but any provided values must be non-negative.
- If `timezone` is provided, it must be a valid IANA timezone string (the API validates this server-side and returns 400 if invalid).
- Period names should be unique within the config (not enforced server-side, but helps UX).

### Effective Scaling Options Preview

When the user is editing periods, you can compute locally what the resolved scaling options would be at any given time by:

1. Finding which period matches a given day+hour (filter by `dayOfWeek` and hour range, pick highest priority).
2. Merging: `{ ...baseScalingOptions, ...matchingPeriod.scalingOptions }`.
3. Clamping: `minDesired <= desiredCount <= maxDesired`.

This allows a "preview" feature showing the effective values for each hour of the week without calling the API.

## Source Files

| File | Purpose |
|------|---------|
| `src/instance_store.ts` | `ScheduledScalingConfig`, `SchedulePeriod`, `ScalingOptions` type definitions |
| `src/scheduled_scaling_processor.ts` | Core logic: timezone resolution, period matching, options merging. Static methods `resolveTimezone`, `findActivePeriod`, `resolveActiveScalingOptions`, `isHourInRange`, `getLocalTime` are all pure functions suitable for sharing with a client |
| `src/handlers.ts` | HTTP handler methods: `updateScheduledScaling`, `getScheduledScaling`, `deleteScheduledScaling` |
| `src/app.ts` | Route registration: `PUT/GET/DELETE /groups/:name/scheduled-scaling` |
| `src/autoscaler.ts` | `isScaleDownInhibited()` — checks active period's `inhibitScaleDown` flag before scale-down evaluation |
| `src/config.ts` | `SCHEDULED_SCALING_ENABLED` (global kill switch), `SCHEDULED_SCALING_DEFAULT_TIMEZONE` |
