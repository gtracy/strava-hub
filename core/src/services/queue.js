const { SQSClient, SendMessageCommand, SendMessageBatchCommand } = require('@aws-sdk/client-sqs');
const logger = require('../logger');

const region = process.env.AWS_REGION || 'us-east-2';
const sqsClient = new SQSClient({ region });

function getSyncQueueUrl() {
  return process.env.SYNC_QUEUE_URL;
}

function getFetchQueueUrl() {
  return process.env.FETCH_QUEUE_URL;
}

/**
 * Enqueue a single activity sync event (create, update, delete).
 * @param {string} athleteId
 * @param {string|number} activityId
 * @param {'create'|'update'|'delete'} aspectType
 * @param {Object} [updates={}]
 */
async function enqueueActivitySync(athleteId, activityId, aspectType, updates = {}) {
  const queueUrl = getSyncQueueUrl();
  if (!queueUrl) {
    throw new Error('SYNC_QUEUE_URL environment variable is not set');
  }

  const payload = {
    athleteId: String(athleteId),
    activityId: String(activityId),
    aspectType,
    updates,
    timestamp: new Date().toISOString(),
  };

  try {
    const command = new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(payload),
    });

    const response = await sqsClient.send(command);
    logger.info(
      { athleteId, activityId, aspectType, messageId: response.MessageId },
      'Enqueued activity sync message'
    );
    return response.MessageId;
  } catch (error) {
    logger.error(
      { athleteId, activityId, aspectType, queueUrl, errMessage: error.message },
      'Failed to enqueue activity sync message'
    );
    throw error;
  }
}

/**
 * Enqueue a batch of activity sync items (e.g. from backfill).
 * @param {string} athleteId
 * @param {Array<{activityId: string, aspectType: string}>} items
 */
async function enqueueActivitySyncBatch(athleteId, items) {
  const queueUrl = getSyncQueueUrl();
  if (!queueUrl) {
    throw new Error('SYNC_QUEUE_URL environment variable is not set');
  }
  if (!items || items.length === 0) {
    return [];
  }

  const athleteIdStr = String(athleteId);
  const now = new Date().toISOString();

  // SQS SendMessageBatch supports max 10 messages per batch
  const batchSize = 10;
  const messageIds = [];

  for (let i = 0; i < items.length; i += batchSize) {
    const chunk = items.slice(i, i + batchSize);
    const entries = chunk.map((item, index) => ({
      Id: `${i + index}`,
      MessageBody: JSON.stringify({
        athleteId: athleteIdStr,
        activityId: String(item.activityId),
        aspectType: item.aspectType || 'create',
        timestamp: now,
      }),
    }));

    try {
      const command = new SendMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: entries,
      });

      const response = await sqsClient.send(command);
      if (response.Successful) {
        messageIds.push(...response.Successful.map((s) => s.MessageId));
      }
      if (response.Failed && response.Failed.length > 0) {
        logger.warn(
          { athleteId: athleteIdStr, failedCount: response.Failed.length },
          'Some messages in SQS batch failed to enqueue'
        );
      }
    } catch (error) {
      logger.error(
        { athleteId: athleteIdStr, errMessage: error.message },
        'Failed to send batch to ActivitySyncQueue'
      );
      throw error;
    }
  }

  logger.info(
    { athleteId: athleteIdStr, count: messageIds.length },
    'Successfully enqueued activity sync batch'
  );
  return messageIds;
}

/**
 * Enqueue an activity historical backfill request.
 * @param {string} athleteId
 * @param {number} [days=60]
 */
async function enqueueActivityFetch(athleteId, days = 60) {
  const queueUrl = getFetchQueueUrl();
  if (!queueUrl) {
    throw new Error('FETCH_QUEUE_URL environment variable is not set');
  }

  const payload = {
    athleteId: String(athleteId),
    days: Number(days),
    requestedAt: new Date().toISOString(),
  };

  try {
    const command = new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(payload),
    });

    const response = await sqsClient.send(command);
    logger.info(
      { athleteId, days, messageId: response.MessageId },
      'Enqueued historical activity fetch request'
    );
    return response.MessageId;
  } catch (error) {
    logger.error(
      { athleteId, days, queueUrl, errMessage: error.message },
      'Failed to enqueue activity fetch request'
    );
    throw error;
  }
}

module.exports = {
  enqueueActivitySync,
  enqueueActivitySyncBatch,
  enqueueActivityFetch,
  sqsClient,
};
