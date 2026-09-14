import winston from 'winston';

export interface AutoscalerLoggerOptions {
    logLevel: string;
}

// winston's json format serializes an Error to {}, because name/message/stack are non-enumerable.
// Every `logger.error('...', { err })` call in the app therefore logged nothing usable. Replace
// top-level Error values with a plain object carrying those fields plus any own enumerable ones
// (ioredis' `code`, oci-sdk's `statusCode`, and so on).
const serializeErrors = winston.format((info) => {
    const fields = <Record<string, unknown>>info;
    for (const [key, value] of Object.entries(fields)) {
        if (value instanceof Error) {
            fields[key] = { ...value, name: value.name, message: value.message, stack: value.stack };
        }
    }
    return info;
});

export default class AutoscalerLogger {
    private logLevel: string;

    constructor(options: AutoscalerLoggerOptions) {
        this.logLevel = options.logLevel;
    }

    createLogger(logLevel = ''): winston.Logger {
        if (!logLevel) {
            logLevel = this.logLevel;
        }
        const options: winston.LoggerOptions = {
            format: winston.format.combine(winston.format.timestamp(), serializeErrors(), winston.format.json()),
            transports: [
                new winston.transports.Console({
                    level: logLevel,
                }),
            ],
        };
        return winston.createLogger(options);
    }
}
