# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
npm install          # Install dependencies
npm run build        # Lint + compile TypeScript to dist/
npm run lint         # ESLint with auto-fix (TypeScript)
npm test             # Run all tests
npm run watch-test   # Re-run tests on file changes
npm run watch        # Compile TypeScript + restart app on changes
npm start            # Run compiled app from dist/app.js
```

**Run a single test file:**
```bash
npx ts-node -r ts-node/register src/test/<filename>.ts
```

## Architecture Overview

**jitsi-autoscaler** manages groups of Jitsi service instances (jibri, jigasi, JVB, etc.) across cloud providers (Oracle Cloud, DigitalOcean, Nomad, custom). It uses a pull-based model: co-located [autoscaler-sidecars](https://github.com/jitsi/jitsi-autoscaler-sidecar) periodically check in via REST, report status/stress metrics, and receive commands (terminate, reconfigure) in response.

### Core Processing Loop

`JobManager` (`src/job_manager.ts`) uses Bee-Queue (Redis-backed) to create and distribute three job types per group:

- **AUTOSCALE** → `AutoscaleProcessor` (`src/autoscaler.ts`): Reads instance stress metrics over configurable periods, adjusts group's desired count based on scaling thresholds
- **LAUNCH** → `InstanceLauncher` (`src/instance_launcher.ts`): Compares running instances vs desired count, launches via cloud providers or sends shutdown commands via sidecar
- **SANITY** → `SanityLoop` (`src/sanity_loop.ts`): Cross-checks sidecar-reported instances against cloud provider records, tracks untracked instances

`MetricsLoop` (`src/metrics_loop.ts`) runs on a separate interval fetching/aggregating metrics from Prometheus or Redis.

### Key Abstractions

- **InstanceStore** (`src/instance_store.ts`): Interface for instance state persistence → `RedisStore` (`src/redis.ts`), `ConsulStore` (`src/consul.ts`)
- **MetricsStore** (`src/metrics_store.ts`): Interface for metrics persistence → `RedisStore`, `PrometheusClient` (`src/prometheus.ts`)
- **CloudInstanceManager** (`src/cloud_instance_manager.ts`): Abstract cloud provider → Oracle, DigitalOcean, Nomad, Custom implementations
- **AutoscalerLockManager** (`src/lock.ts`): Distributed locking (Redis Redlock or Consul) for group-level coordination

### App Wiring

`src/app.ts` is the entry point — it constructs all components with dependency injection, sets up Express routes with JWT auth (via ASAP), and starts the job creation loops. `src/config.ts` loads all env vars via `envalid`. `src/context.ts` provides per-request context (logger, tracing ID).

### REST API

Routes are defined in `src/app.ts`, handlers in `src/handlers.ts`:
- `POST /sidecar/poll|stats|status|shutdown` — sidecar communication
- `GET/PUT/DELETE /groups/:name` — group CRUD
- `PUT /groups/:name/desired|scaling-options|scaling-activities` — group tuning
- `GET /groups/:name/report|group-audit|instance-audit` — observability
- `PUT /groups/options/full-scaling` — bulk scaling (used by external schedulers)
- `POST /groups/:name/actions/reconfigure-instances|launch-protected` — group actions

## Code Conventions

- **TypeScript** with `noImplicitAny: true`, target ES2020, CommonJS modules
- **ESLint + Prettier**: Run via `npm run lint`. Unused args must be prefixed with `_`
- **Testing**: Node.js native `test` module (`node:test` + `node:assert`). Tests in `src/test/`. Mock Redis via `src/test/mock-redis-client.ts`, mock stores via `src/test/mock_store.ts`
- **Dependency injection**: All major classes take an options object in constructor
- **Context pattern**: `Context` object (logger + request ID) threaded through all async operations
- **Node.js >=20** required
