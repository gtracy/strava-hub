const pino = require('pino');

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: {
    app: 'hello-world',
    env: process.env.STAGE || 'dev',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

/**
 * Format meters to kilometers and miles.
 */
function formatDistance(meters = 0) {
  const km = (meters / 1000).toFixed(2);
  const miles = (meters * 0.000621371).toFixed(2);
  return { km, miles };
}

/**
 * Format moving time in seconds to human readable duration.
 */
function formatDuration(seconds = 0) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m ${remainingSeconds}s`;
}

/**
 * Hello World Event Consumer Handler.
 * Receives SQS records wrapping EventBridge activity notifications.
 * @param {Object} event - AWS SQS event
 */
async function handler(event) {
  logger.info({ recordCount: event.Records?.length }, 'HelloWorld consumer received SQS batch');

  const results = [];

  for (const record of event.Records || []) {
    let eventBridgeEvent;
    try {
      eventBridgeEvent = JSON.parse(record.body);
    } catch (parseErr) {
      logger.error({ body: record.body, errMessage: parseErr.message }, 'Failed to parse SQS message body');
      continue;
    }

    // When EventBridge targets SQS, record.body contains the EventBridge event envelope
    const detail = eventBridgeEvent.detail || eventBridgeEvent;
    const {
      athleteId,
      activityId,
      aspectType = 'create',
      name = 'Untitled Workout',
      type = 'Activity',
      distance = 0,
      movingTime = 0,
      summaryPolyline,
      s3Key,
    } = detail;

    logger.info(
      { athleteId, activityId, aspectType, name, type },
      'Processing activity event in HelloWorld app'
    );

    try {
      const distanceFormatted = formatDistance(distance);
      const durationFormatted = formatDuration(movingTime);

      const cheerMessage = `🎉 High five! Athlete ${athleteId} completed a ${type} ("${name}"): ${distanceFormatted.km} km (${distanceFormatted.miles} mi) in ${durationFormatted}!`;

      logger.info(
        {
          athleteId,
          activityId,
          distance: distanceFormatted,
          duration: durationFormatted,
          hasRouteMap: !!summaryPolyline,
          s3PayloadLocation: s3Key,
        },
        cheerMessage
      );

      results.push({
        athleteId,
        activityId,
        status: 'processed',
        cheer: cheerMessage,
      });
    } catch (error) {
      logger.error(
        { athleteId, activityId, errMessage: error.message, stack: error.stack },
        'Error processing activity in HelloWorld consumer'
      );
      throw error; // Re-throw to trigger SQS retry or DLQ
    }
  }

  return {
    processed: results.length,
    results,
  };
}

module.exports = {
  handler,
  formatDistance,
  formatDuration,
};
