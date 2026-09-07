const logger = require('../logger');
const athleteRepository = require('../repositories/athlete-repository');
const stravaService = require('../services/strava');
const queueService = require('../services/queue');
const { getValidAccessToken } = require('./sync-worker');
const { RateLimitError, TokenRevokedError } = require('../services/strava');

/**
 * Lambda handler for SQS ActivityFetchQueue records (historical backfill).
 * @param {Object} event - AWS SQS event
 */
async function handler(event) {
  logger.info({ recordCount: event.Records?.length }, 'FetchWorker received SQS batch');

  for (const record of event.Records || []) {
    let messageBody;
    try {
      messageBody = JSON.parse(record.body);
    } catch (parseErr) {
      logger.error({ body: record.body, errMessage: parseErr.message }, 'Failed to parse SQS message body');
      continue;
    }

    const { athleteId, days = 60 } = messageBody;
    logger.info({ athleteId, days }, 'Starting historical activity backfill');

    try {
      const athlete = await athleteRepository.getAthlete(athleteId, { decryptTokens: true });
      if (!athlete) {
        logger.warn({ athleteId }, 'Athlete not found in database, skipping fetch');
        continue;
      }

      let accessToken;
      try {
        accessToken = await getValidAccessToken(athlete);
      } catch (tokenErr) {
        if (tokenErr instanceof TokenRevokedError) {
          logger.warn({ athleteId }, 'Athlete revoked access, skipping fetch');
          continue;
        }
        throw tokenErr;
      }

      const nowEpoch = Math.floor(Date.now() / 1000);
      const afterEpoch = nowEpoch - days * 24 * 60 * 60;

      let page = 1;
      const perPage = 50;
      let totalEnqueued = 0;
      let hasMore = true;

      while (hasMore) {
        logger.debug({ athleteId, page, perPage }, 'Fetching activity page from Strava');
        const activities = await stravaService.listActivities(
          accessToken,
          afterEpoch,
          nowEpoch,
          page,
          perPage
        );

        if (!activities || activities.length === 0) {
          hasMore = false;
          break;
        }

        const batch = activities.map((act) => ({
          activityId: String(act.id),
          aspectType: 'create',
        }));

        await queueService.enqueueActivitySyncBatch(athleteId, batch);
        totalEnqueued += batch.length;

        if (activities.length < perPage) {
          hasMore = false;
        } else {
          page += 1;
        }
      }

      logger.info(
        { athleteId, days, totalEnqueued },
        'Completed historical activity backfill enqueue'
      );
    } catch (error) {
      if (error instanceof RateLimitError) {
        logger.warn(
          { athleteId, days, errMessage: error.message },
          'Strava rate limit exceeded during backfill; re-throwing for SQS retry'
        );
        throw error;
      }

      logger.error(
        { athleteId, days, errMessage: error.message, stack: error.stack },
        'Error during historical activity backfill'
      );
      throw error;
    }
  }
}

module.exports = {
  handler,
};
