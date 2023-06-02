#!/bin/bash

# last tag 0.0.1
docker buildx build --no-cache --platform=linux/arm64,linux/amd64 --push --pull --progress=plain --tag jitsi/autoscaler:$TAG --tag jitsi/autoscaler:latest .
