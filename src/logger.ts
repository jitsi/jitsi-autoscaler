import winston from 'winston';
import config from './config';

const options: winston.LoggerOptions = {
    transports: [
        new winston.transports.Console({
            level: config.LogLevel,
        }),
    ],
};

const logger = winston.createLogger(options);

export default logger;
