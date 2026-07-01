import { timeStamp } from 'node:console';
import { format } from 'node:path';
import winston, { level } from 'winston';

const logger = winston.createLogger({
    level: process.env.NODE_ENV == 'production' ? 'info' : 'debug',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.errors({ stack: true }),
        winston.format.json()
    ),
    defaultMeta: { service: 'nomba-billing-engine' },
    transports: [
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.printf(({ timestamp, level, message, service, ...meta}) => {
                    const metaStr = Object.keys(meta).length ? `${JSON.stringify(meta)}` : '';
                    return `[${timeStamp}] [${level}]: ${message}${metaStr}`
                })
            )
        })
    ]
})

export default logger;