const pino = require('pino');

const logLevel = process.env.LOG_LEVEL || 'info';

const logger = pino({
  level: logLevel,
  base: {
    service: 'strava-hub',
    env: process.env.STAGE || process.env.NODE_ENV || 'dev',
  },
  redact: {
    paths: [
      'accessToken',
      'refreshToken',
      '*.accessToken',
      '*.refreshToken',
      'token',
      'clientSecret',
      'client_secret',
      'authorization',
      'headers.authorization',
      'headers.Authorization',
    ],
    censor: '[REDACTED]',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

module.exports = logger;
