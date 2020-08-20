import winston from 'winston';
import config from './config';

const options: winston.LoggerOptions = {
    format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
    transports: [
        new winston.transports.Console({
            level: config.LogLevel,
        }),
    ],
};

const logger = winston.createLogger(options);

export default logger;
