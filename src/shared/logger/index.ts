import winston from 'winston';

/**
 * Application-wide logger singleton configured with Winston.
 *
 * Writes error-level logs to `logs/error.log`, all logs to
 * `logs/combined.log`, and outputs to the console in both
 * development (colorized, simple format) and production
 * (JSON format) environments.
 */
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json(),
  ),
  defaultMeta: { service: 'filedrop' },
  transports: [
    // Write all logs including error logs to file
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' }),
    // Console transport for docker logs / CLI visibility
    new winston.transports.Console({
      format:
        process.env.NODE_ENV !== 'production'
          ? winston.format.combine(winston.format.colorize(), winston.format.simple())
          : winston.format.json(),
    }),
  ],
});

export default logger;