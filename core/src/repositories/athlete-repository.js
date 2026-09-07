const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
  UpdateCommand,
} = require('@aws-sdk/lib-dynamodb');
const kmsService = require('../services/kms');
const logger = require('../logger');

const region = process.env.AWS_REGION || 'us-east-2';
const ddbClient = new DynamoDBClient({ region });
const docClient = DynamoDBDocumentClient.from(ddbClient);

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
  const idStr = String(athleteId);
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
    } else {
      item.createdAt = existing.createdAt || now;
      item.totalActivities = existing.totalActivities || 0;
      item.lastSyncAt = existing.lastSyncAt || null;
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

module.exports = {
  saveAthlete,
  getAthlete,
  updateSyncStatus,
  deleteAthlete,
  docClient,
  ddbClient,
};
