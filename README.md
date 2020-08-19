# jitsi-autoscaler

## Building
```
npm install
npm run build
```

You can find the build in `dist/`. There's only one bundled file there - `main.js`.

## Runnning

```
npm run build
npm run start
```

or after the build is done:

```
node dist/main.js
```

### Config.json

You must specify the path to a `groups.json` file as an environment variable. We read the groups for autoscaling from there.

## docker-compose

To run the demo docker-compose setup, all config must be added to the config/ directory.
The following commands may then be used:

### build the images
```
docker-compose -f demo/docker-compose.yml build
```

### start up the containers
```
docker-compose -f demo/docker-compose.yml up
```

### tear down the containers
```
docker-compose -f demo/docker-compose.yml down
```
