#!/bin/bash

set -e

# pre-run.sh is intended to include environment specific
# setup such as env var injection of secrets.
if [ -f /usr/jitsi/pre-run.sh ]; then
    . /usr/jitsi/pre-run.sh
fi

if [ "$ENABLE_NODE_PERF" == "true" ]; then
    NODE_CMD_PREFIX="perf record -e cycles:u -g --"
    NODE_PERF_PARAM="--perf-basic-prof"
fi

if [ "$ENABLE_PROFILING" == "true" ]; then
    NODE_PERF_PARAM="--prof"
fi

exec $NODE_CMD_PREFIX node $NODE_PERF_PARAM /usr/src/app/app.js
