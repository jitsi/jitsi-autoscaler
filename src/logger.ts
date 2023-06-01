import winston from 'winston';

export interface AutoscalerLoggerOptions {
    logLevel: string;
}

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
            format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
            transports: [
                new winston.transports.Console({
                    level: logLevel,
                }),
            ],
        };
        return winston.createLogger(options);
    }
}
