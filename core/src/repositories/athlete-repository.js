const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
  UpdateCommand,
} = require('@aws-sdk/lib-dynamodb');
const kmsService = require('../services/kms');
const stravaService = require('../services/strava');
const logger = require('../logger');

const region = process.env.AWS_REGION || 'us-east-2';
const ddbClient = new DynamoDBClient({ region });
const docClient = DynamoDBDocumentClient.from(ddbClient);

function isValidAthleteId(id) {
  return typeof id === 'string' && /^\d+$/.test(id);
}

function getTableName() {
  return process.env.ATHLETES_TABLE_NAME || `strava-hub-${process.env.STAGE || 'dev'}-athletes`;
}

/**
 * Save or update an athlete profile with encrypted tokens.
 * @param {Object} params
 * @param {string} params.athleteId - Strava Athlete ID (numeric string)
 * @param {string} [params.firstname]
 * @param {string} [params.lastname]
 * @param {string} [params.profile] - Profile avatar URL
 * @param {string} [params.accessToken] - Strava access token (will be encrypted)
 * @param {string} [params.refreshToken] - Strava refresh token (will be encrypted)
 * @param {number} [params.expiresAt] - Token expiration unix timestamp
 * @param {string} [params.city]
 * @param {string} [params.state]
 * @param {string} [params.country]
 */
async function saveAthlete({
  athleteId,
  firstname,
  lastname,
  profile,
  accessToken,
  refreshToken,
  expiresAt,
  city,
  state,
  country,
  measurementPreference,
}) {
  const tableName = getTableName();
  const idStr = String(athleteId || '');
  if (!isValidAthleteId(idStr)) {
    throw new Error('Invalid athlete ID');
  }
  const now = new Date().toISOString();

  let encryptedAccessToken = null;
  let encryptedRefreshToken = null;

  try {
    if (accessToken) {
      encryptedAccessToken = await kmsService.encrypt(accessToken);
    }
    if (refreshToken) {
      encryptedRefreshToken = await kmsService.encrypt(refreshToken);
    }
  } catch (error) {
    logger.error(
      { athleteId: idStr, errMessage: error.message },
      'Failed to encrypt athlete tokens before saving'
    );
    throw error;
  }

  const item = {
    athleteId: idStr,
    firstname: firstname || null,
    lastname: lastname || null,
    profile: profile || null,
    city: city || null,
    state: state || null,
    country: country || null,
    measurementPreference: measurementPreference || null,
    expiresAt: expiresAt || null,
    updatedAt: now,
  };

  if (encryptedAccessToken) {
    item.encryptedAccessToken = encryptedAccessToken;
  }
  if (encryptedRefreshToken) {
    item.encryptedRefreshToken = encryptedRefreshToken;
  }

  try {
    const existing = await getAthlete(idStr, { decryptTokens: false });
    if (!existing) {
      item.createdAt = now;
      item.totalActivities = 0;
      item.lastSyncAt = null;
      item.tier = 'free';
    } else {
      item.createdAt = existing.createdAt || now;
      item.totalActivities = existing.totalActivities || 0;
      item.lastSyncAt = existing.lastSyncAt || null;
      item.tier = existing.tier || 'free';
      if (existing.syncJob) {
        item.syncJob = existing.syncJob;
      }
      if (!encryptedAccessToken && existing.encryptedAccessToken) {
        item.encryptedAccessToken = existing.encryptedAccessToken;
      }
      if (!encryptedRefreshToken && existing.encryptedRefreshToken) {
        item.encryptedRefreshToken = existing.encryptedRefreshToken;
      }
    }

    const command = new PutCommand({
      TableName: tableName,
      Item: item,
    });

    await docClient.send(command);

    logger.info(
      { athleteId: idStr, tableName },
      'Successfully saved athlete profile'
    );

    return item;
  } catch (error) {
    logger.error(
      { athleteId: idStr, tableName, errMessage: error.message },
      'Failed to save athlete to DynamoDB'
    );
    throw error;
  }
}

/**
 * Fetch an athlete by Strava Athlete ID.
 * @param {string} athleteId
 * @param {Object} [options]
 * @param {boolean} [options.decryptTokens=true] - Whether to decrypt OAuth tokens
 */
async function getAthlete(athleteId, { decryptTokens = true } = {}) {
  const tableName = getTableName();
  const idStr = String(athleteId);

  try {
    const command = new GetCommand({
      TableName: tableName,
      Key: { athleteId: idStr },
    });

    const response = await docClient.send(command);
    const item = response.Item;

    if (!item) {
      return null;
    }

    if (decryptTokens) {
      try {
        if (item.encryptedAccessToken) {
          item.accessToken = await kmsService.decrypt(item.encryptedAccessToken);
        }
        if (item.encryptedRefreshToken) {
          item.refreshToken = await kmsService.decrypt(item.encryptedRefreshToken);
        }
      } catch (decryptErr) {
        logger.error(
          { athleteId: idStr, errMessage: decryptErr.message },
          'Failed to decrypt stored athlete tokens'
        );
        throw decryptErr;
      }
    }

    return item;
  } catch (error) {
    logger.error(
      { athleteId: idStr, tableName, errMessage: error.message },
      'Failed to get athlete from DynamoDB'
    );
    throw error;
  }
}

/**
 * Update the lastSyncAt timestamp and activity count for an athlete.
 * @param {string} athleteId
 * @param {string} lastSyncAt - ISO date string
 * @param {number} [totalActivities] - Total activities count
 */
async function updateSyncStatus(athleteId, lastSyncAt, totalActivities) {
  const tableName = getTableName();
  const idStr = String(athleteId);
  const now = new Date().toISOString();

  let updateExpression = 'SET lastSyncAt = :lastSyncAt, updatedAt = :updatedAt';
  const expressionAttributeValues = {
    ':lastSyncAt': lastSyncAt,
    ':updatedAt': now,
  };

  if (typeof totalActivities === 'number') {
    updateExpression += ', totalActivities = :totalActivities';
    expressionAttributeValues[':totalActivities'] = totalActivities;
  }

  try {
    const command = new UpdateCommand({
      TableName: tableName,
      Key: { athleteId: idStr },
      UpdateExpression: updateExpression,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: 'ALL_NEW',
    });

    const result = await docClient.send(command);
    logger.info({ athleteId: idStr, lastSyncAt }, 'Updated athlete sync status');
    return result.Attributes;
  } catch (error) {
    logger.error(
      { athleteId: idStr, tableName, errMessage: error.message },
      'Failed to update athlete sync status'
    );
    throw error;
  }
}

/**
 * Delete an athlete record from DynamoDB.
 * @param {string} athleteId
 */
async function deleteAthlete(athleteId) {
  const tableName = getTableName();
  const idStr = String(athleteId);

  try {
    const command = new DeleteCommand({
      TableName: tableName,
      Key: { athleteId: idStr },
    });

    await docClient.send(command);
    logger.info({ athleteId: idStr, tableName }, 'Deleted athlete record');
    return true;
  } catch (error) {
    logger.error(
      { athleteId: idStr, tableName, errMessage: error.message },
      'Failed to delete athlete from DynamoDB'
    );
    throw error;
  }
}

/**
 * Ensure an active, valid Strava access token for the athlete, refreshing if expired.
 * Centralized DRY implementation.
 * @param {Object|string} athleteOrId
 * @returns {Promise<string>} Valid access token
 */
async function getValidAccessToken(athleteOrId) {
  let athlete = athleteOrId;
  if (typeof athleteOrId === 'string') {
    athlete = await getAthlete(athleteOrId, { decryptTokens: true });
  } else if (!athlete.accessToken && athlete.encryptedAccessToken) {
    athlete = await getAthlete(athlete.athleteId, { decryptTokens: true });
  }

  if (!athlete) {
    throw new Error('Athlete not found');
  }

  const nowEpoch = Math.floor(Date.now() / 1000);
  const bufferSeconds = 300; // 5 minute buffer

  if (athlete.accessToken && athlete.expiresAt && athlete.expiresAt > nowEpoch + bufferSeconds) {
    return athlete.accessToken;
  }

  logger.info(
    { athleteId: athlete.athleteId },
    'Strava token expired or expiring soon; refreshing token'
  );

  const refreshed = await stravaService.refreshToken(athlete.refreshToken);
  await saveAthlete({
    athleteId: athlete.athleteId,
    accessToken: refreshed.access_token,
    refreshToken: refreshed.refresh_token,
    expiresAt: refreshed.expires_at,
  });

  return refreshed.access_token;
}

/**
 * Acquire an atomic lock for a historical backfill job.
 * Fails with ConditionalCheckFailedException if a job is already 'syncing' within 5 minutes.
 * @param {string} athleteId
 * @param {string} jobId - Unique UUID
 * @param {number} days - Number of days to backfill
 */
async function acquireSyncLock(athleteId, jobId, days) {
  const tableName = getTableName();
  const idStr = String(athleteId);
  if (!isValidAthleteId(idStr)) {
    throw new Error('Invalid athlete ID');
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const fiveMinutesAgoIso = new Date(now.getTime() - 5 * 60 * 1000).toISOString();

  const syncJob = {
    jobId,
    status: 'syncing',
    startedAt: nowIso,
    days,
    count: 0,
  };

  const command = new UpdateCommand({
    TableName: tableName,
    Key: { athleteId: idStr },
    UpdateExpression: 'SET syncJob = :newJob, updatedAt = :now',
    ConditionExpression:
      'attribute_exists(athleteId) AND (attribute_not_exists(syncJob) OR syncJob.#status <> :syncing OR syncJob.startedAt < :fiveMinutesAgo)',
    ExpressionAttributeNames: {
      '#status': 'status',
    },
    ExpressionAttributeValues: {
      ':newJob': syncJob,
      ':now': nowIso,
      ':syncing': 'syncing',
      ':fiveMinutesAgo': fiveMinutesAgoIso,
    },
    ReturnValues: 'ALL_NEW',
  });

  const response = await docClient.send(command);
  logger.info({ athleteId: idStr, jobId, days }, 'Acquired historical sync lock');
  return response.Attributes?.syncJob;
}

/**
 * Transition a sync job to completed or failed.
 * @param {string} athleteId
 * @param {string} jobId
 * @param {'completed'|'failed'} status
 * @param {number} [count=0]
 */
async function completeSyncJob(athleteId, jobId, status, count = 0) {
  const tableName = getTableName();
  const idStr = String(athleteId);
  const nowIso = new Date().toISOString();

  let updateExpression =
    'SET syncJob.#status = :status, syncJob.completedAt = :now, syncJob.#count = :count, updatedAt = :now';
  const expressionAttributeValues = {
    ':status': status,
    ':now': nowIso,
    ':count': count,
    ':jobId': jobId,
  };

  if (status === 'completed') {
    updateExpression += ', lastSyncAt = :now';
  }

  try {
    const command = new UpdateCommand({
      TableName: tableName,
      Key: { athleteId: idStr },
      UpdateExpression: updateExpression,
      ConditionExpression: 'attribute_exists(athleteId) AND syncJob.jobId = :jobId',
      ExpressionAttributeNames: {
        '#status': 'status',
        '#count': 'count',
      },
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: 'ALL_NEW',
    });

    const response = await docClient.send(command);
    logger.info({ athleteId: idStr, jobId, status, count }, 'Updated historical sync job state');
    return response.Attributes?.syncJob;
  } catch (error) {
    logger.error(
      { athleteId: idStr, jobId, status, errMessage: error.message },
      'Failed to update historical sync job state (may be superseded by newer job)'
    );
    return null;
  }
}

module.exports = {
  saveAthlete,
  getAthlete,
  getValidAccessToken,
  acquireSyncLock,
  completeSyncJob,
  updateSyncStatus,
  deleteAthlete,
  isValidAthleteId,
  docClient,
  ddbClient,
};
