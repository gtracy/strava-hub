const pino = require('pino');

const logLevel = process.env.LOG_LEVEL || 'info';

const logger = pino({
  level: logLevel,
  base: {
    service: 'strava-hub',
    env: process.env.STAGE || process.env.NODE_ENV || 'dev',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

module.exports = logger;
