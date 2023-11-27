#!/bin/bash

# last tag 0.0.22
docker buildx build --no-cache --platform=linux/arm64,linux/amd64 --push --pull --progress=plain --tag jitsi/autoscaler:$TAG --tag jitsi/autoscaler:latest .

if [ $? -ne 0 ]; then
    echo "Build failed"
    exit 1
fi

git tag -a "docker-$TAG" -m "Published in dockerhub as jitsi/autoscaler:$TAG"
git push origin "docker-$TAG"
