# jitsi-autoscaler

## Building
```
npm install
npm run build
```

You can find the build in `dist/`. There's only one bundled file there - `main.js`.

## Runnning

```
npm start <path_to_config_json>
```

or

```
node dist/main.js <path_to_config_json>
```

### Config.json

You must specify the path to a `config.json` file as a first argument of the app. We read the following properties from there:
 - jwt - required. Configuration options for the JWT generation.
   - privateKeyPath - required. The path to the private key.
   - keyid - required. The kid claim.
   - iss - required. The iss claim.
   - expiresIn - required. Period of time after which the JWT will expire.
 - debug - optional. Enable the debug log level.
