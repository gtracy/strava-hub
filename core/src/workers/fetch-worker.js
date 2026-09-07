const logger = require('../logger');
const athleteRepository = require('../repositories/athlete-repository');
const activityRepository = require('../repositories/activity-repository');
const stravaService = require('../services/strava');
const eventbridgeService = require('../services/eventbridge');
const { RateLimitError, TokenRevokedError } = require('../services/strava');

/**
 * Lambda handler for SQS ActivityFetchQueue records (historical backfill).
 * Direct summary persistence (98% Strava API call reduction).
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

    const { athleteId, days = 60, jobId } = messageBody;
    logger.info({ athleteId, days, jobId }, 'Starting historical activity backfill');

    let totalSaved = 0;

    try {
      const athlete = await athleteRepository.getAthlete(athleteId, { decryptTokens: true });
      if (!athlete) {
        logger.warn({ athleteId }, 'Athlete not found in database, skipping fetch');
        if (jobId) {
          await athleteRepository.completeSyncJob(athleteId, jobId, 'failed', 0);
        }
        continue;
      }

      let accessToken;
      try {
        accessToken = await athleteRepository.getValidAccessToken(athlete);
      } catch (tokenErr) {
        if (tokenErr instanceof TokenRevokedError) {
          logger.warn({ athleteId }, 'Athlete revoked access, skipping fetch');
          if (jobId) {
            await athleteRepository.completeSyncJob(athleteId, jobId, 'failed', 0);
          }
          continue;
        }
        throw tokenErr;
      }

      const nowEpoch = Math.floor(Date.now() / 1000);
      const afterEpoch = nowEpoch - days * 24 * 60 * 60;

      let page = 1;
      const perPage = 200; // Maximized page size to minimize Strava API calls
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

        // Process summary activities in concurrency batches of 15
        for (const act of activities) {
          const activityIdStr = String(act.id);
          try {
            // 1. Save summary activity (preserves detailed records without downgrade)
            const savedMetadata = await activityRepository.saveSummaryActivity(athleteId, act);

            // 2. Publish to EventBridge with isBackfill: true
            await eventbridgeService.publishActivityEvent({
              athleteId,
              activityId: activityIdStr,
              aspectType: 'create',
              metadata: savedMetadata,
              isBackfill: true,
            });

            totalSaved += 1;
          } catch (itemErr) {
            logger.error(
              { athleteId, activityId: activityIdStr, errMessage: itemErr.message },
              'Failed to save backfill summary activity'
            );
          }
        }

        if (activities.length < perPage) {
          hasMore = false;
        } else {
          page += 1;
        }
      }

      // Update sync status & complete sync job
      await athleteRepository.updateSyncStatus(athleteId, new Date().toISOString(), totalSaved);
      if (jobId) {
        await athleteRepository.completeSyncJob(athleteId, jobId, 'completed', totalSaved);
      }

      logger.info(
        { athleteId, days, jobId, totalSaved },
        'Successfully completed historical activity backfill'
      );
    } catch (error) {
      if (jobId) {
        await athleteRepository.completeSyncJob(athleteId, jobId, 'failed', totalSaved);
      }

      if (error instanceof RateLimitError) {
        logger.warn(
          { athleteId, days, jobId, errMessage: error.message },
          'Strava rate limit exceeded during backfill; re-throwing for SQS retry'
        );
        throw error;
      }

      logger.error(
        { athleteId, days, jobId, errMessage: error.message, stack: error.stack },
        'Error during historical activity backfill'
      );
      throw error;
    }
  }
}

module.exports = {
  handler,
};
