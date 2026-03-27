# Scheduled Scaling Feature

Scheduled scaling allows instance groups to automatically adjust their scaling parameters based on time of day and day of week. This enables pre-warming capacity before daily peak hours and scaling down during off-peak times and weekends.

## Concepts

### How It Works

Each group can have a `scheduledScaling` configuration containing:

1. **Periods** — named time windows (e.g., "weekday-peak", "weekend") that override specific scaling parameters when active.
2. **Timezone** — either explicitly set or auto-derived from the group's cloud region.

Every ~30 seconds, the scheduler checks whether a **period boundary has been crossed** for each group. It only modifies scaling options when a period starts, ends, or switches — not on every cycle. This means:

- **When a period starts**: The group's current `scalingOptions` are snapshotted as a baseline (`scheduledScalingBaseOptions`), and the period's overrides are merged onto that baseline.
- **When switching periods**: The new period's overrides are merged onto the original baseline (not the previous period's values).
- **When all periods end**: The baseline is restored, returning the group to its pre-scheduled-scaling state.
- **While the same period is active**: The processor does nothing. Admin changes via `PUT /groups/:name/desired` or the autoscaler are preserved until the next boundary crossing.

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
- The current local time falls within the `[startHour:startMinute, endHour:endMinute)` range.

When multiple periods match simultaneously, the one with the highest `priority` value wins.

### Time Ranges

Time ranges are specified with `startHour`/`startMinute` and `endHour`/`endMinute`. The minute fields are optional and default to 0.

- **Normal range**: e.g., `startHour: 8, endHour: 20` means 8:00 to 19:59.
- **Minute-level range**: e.g., `startHour: 7, startMinute: 45, endHour: 8, endMinute: 0` means 7:45 to 7:59. Use this to pre-warm capacity before peak hours.
- **Midnight wrap**: e.g., `startHour: 22, endHour: 6` means 22:00 to 5:59 (crosses midnight).
- **All day**: `startHour === endHour` and `startMinute === endMinute` (typically `0:00, 0:00`) — matches all 24 hours.

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
    periods: SchedulePeriod[];
}
```

### SchedulePeriod

```typescript
interface SchedulePeriod {
    name: string;                   // human-readable label, e.g., "weekday-peak"
    dayOfWeek: number[];            // 0=Sunday, 1=Monday, ..., 6=Saturday
    startHour: number;              // 0-23, inclusive
    startMinute?: number;           // 0-59, defaults to 0
    endHour: number;                // 0-23, exclusive (wraps midnight if <= startHour)
    endMinute?: number;             // 0-59, defaults to 0
    priority: number;               // higher number wins when periods overlap
    scalingOptions: Partial<ScalingOptions>;  // only overridden fields needed
    inhibitScaleDown?: boolean;     // if true, prevents autoscaler scale-down during this period
}
```

### ScalingOptions

The group's existing `scalingOptions` serve as the base. Period overrides can partially replace these fields:

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

**Request body:** A `ScheduledScalingConfig` object. Period `scalingOptions` are merged onto the group's existing `scalingOptions` — only override the fields you want to change.

```json
{
    "enabled": true,
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

**Group Scaling Options**: The group's existing `scalingOptions` (set via `PUT /groups/:name/desired` or `PUT /groups/:name/scaling-options`) serve as the base. When no period matches, these values remain unchanged. Periods only override the specific fields they define.

**Periods List/Table**: Each period needs:
- `name` — free-text label
- `dayOfWeek` — multi-select of days (Sunday through Saturday). Display as checkboxes or a weekly calendar strip.
- `startHour` / `startMinute` / `endHour` / `endMinute` — time pickers. Hours 0-23, minutes 0-59 (minutes default to 0 if omitted). When start equals end, display as "All day". When start > end, indicate the range wraps midnight.
- `priority` — integer. Higher wins. Consider defaulting to 10 for the first period and auto-incrementing, or let the user drag-to-reorder and derive priority from order.
- `inhibitScaleDown` — checkbox, labeled something like "Prevent scale-down during this period".
- `scalingOptions` — partial override form. Only show fields the user wants to override; omitted fields inherit from base. The most commonly overridden fields are `minDesired`, `maxDesired`, and `desiredCount`.

**Active Period Indicator**: Highlight which period (if any) is currently active. The `activePeriod` field from the GET response tells you this. If `null`, no period overrides are in effect and the group's current `scalingOptions` are unchanged.

**Weekly Timeline Visualization** (optional but recommended): A 7-day × 24-hour grid showing which period is active at each hour, color-coded by period name. This makes it easy to see coverage gaps and overlaps at a glance.

### Saving Changes

Always `PUT` the entire `ScheduledScalingConfig` as a single request. The API does not support partial updates — you must send the full config including all periods.

### Validation Rules to Enforce Client-Side

- Each period must have a non-empty `name`, at least one day in `dayOfWeek`, `startHour` and `endHour` in range 0-23, optional `startMinute` and `endMinute` in range 0-59, and a numeric `priority`.
- Period `scalingOptions` fields are all optional, but any provided values must be non-negative.
- If `timezone` is provided, it must be a valid IANA timezone string (the API validates this server-side and returns 400 if invalid).
- Period names should be unique within the config (not enforced server-side, but helps UX).

### Effective Scaling Options Preview

When the user is editing periods, you can compute locally what the resolved scaling options would be at any given time by:

1. Finding which period matches a given day+time (filter by `dayOfWeek` and time range, pick highest priority).
2. Merging: `{ ...group.scalingOptions, ...matchingPeriod.scalingOptions }`.
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
