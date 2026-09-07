const logger = require('../logger');
const athleteRepository = require('../repositories/athlete-repository');
const activityRepository = require('../repositories/activity-repository');
const stravaService = require('../services/strava');
const eventbridgeService = require('../services/eventbridge');
const { RateLimitError, TokenRevokedError } = require('../services/strava');

// Use centralized getValidAccessToken from athleteRepository
const getValidAccessToken = athleteRepository.getValidAccessToken;

/**
 * Lambda handler for SQS ActivitySyncQueue records.
 * @param {Object} event - AWS SQS event
 */
async function handler(event) {
  logger.info({ recordCount: event.Records?.length }, 'SyncWorker received SQS batch');

  for (const record of event.Records || []) {
    let messageBody;
    try {
      messageBody = JSON.parse(record.body);
    } catch (parseErr) {
      logger.error({ body: record.body, errMessage: parseErr.message }, 'Failed to parse SQS message body');
      continue;
    }

    const { athleteId, activityId, aspectType = 'create' } = messageBody;
    logger.info({ athleteId, activityId, aspectType }, 'Processing sync record');

    try {
      const athlete = await athleteRepository.getAthlete(athleteId, { decryptTokens: true });
      if (!athlete) {
        logger.warn({ athleteId, activityId }, 'Athlete not found in database, skipping sync');
        continue;
      }

      // Handle activity deletion
      if (aspectType === 'delete') {
        await activityRepository.deleteActivity(athleteId, activityId);
        await eventbridgeService.publishActivityEvent({
          athleteId,
          activityId,
          aspectType: 'delete',
        });
        logger.info({ athleteId, activityId }, 'Processed activity deletion');
        continue;
      }

      // Handle activity create or update: fetch detailed payload from Strava
      let accessToken;
      try {
        accessToken = await getValidAccessToken(athlete);
      } catch (tokenErr) {
        if (tokenErr instanceof TokenRevokedError) {
          logger.warn(
            { athleteId, errMessage: tokenErr.message },
            'Athlete revoked Strava access; skipping sync'
          );
          continue;
        }
        throw tokenErr;
      }

      let detailedActivity;
      try {
        detailedActivity = await stravaService.getActivity(accessToken, activityId);
      } catch (fetchErr) {
        if (fetchErr instanceof TokenRevokedError) {
          // Token might have just expired; try one refresh
          logger.info({ athleteId }, 'Token rejected on fetch; attempting refresh');
          accessToken = await getValidAccessToken({ ...athlete, expiresAt: 0 });
          detailedActivity = await stravaService.getActivity(accessToken, activityId);
        } else {
          throw fetchErr;
        }
      }

      // 1. Save metadata to DynamoDB & full JSON to S3
      const savedMetadata = await activityRepository.saveActivity(athleteId, detailedActivity);

      // 2. Update athlete sync timestamp
      await athleteRepository.updateSyncStatus(athleteId, new Date().toISOString());

      // 3. Publish event to EventBridge
      await eventbridgeService.publishActivityEvent({
        athleteId,
        activityId,
        aspectType,
        metadata: savedMetadata,
      });

      logger.info(
        { athleteId, activityId, aspectType, name: savedMetadata.name },
        'Successfully processed and published activity event'
      );
    } catch (error) {
      if (error instanceof RateLimitError) {
        logger.warn(
          { athleteId, activityId, errMessage: error.message },
          'Strava rate limit exceeded; re-throwing for SQS retry backoff'
        );
        throw error;
      }

      logger.error(
        { athleteId, activityId, errMessage: error.message, stack: error.stack },
        'Error processing sync message'
      );
      throw error;
    }
  }
}

module.exports = {
  handler,
  getValidAccessToken,
};
