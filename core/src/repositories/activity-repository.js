const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  QueryCommand,
  DeleteCommand,
} = require('@aws-sdk/lib-dynamodb');
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} = require('@aws-sdk/client-s3');
const logger = require('../logger');

const region = process.env.AWS_REGION || 'us-east-2';
const ddbClient = new DynamoDBClient({ region });
const docClient = DynamoDBDocumentClient.from(ddbClient);
const s3Client = new S3Client({ region });

function isValidId(id) {
  return typeof id === 'string' && /^\d+$/.test(id);
}

function getTableName() {
  return process.env.ACTIVITIES_TABLE_NAME || `strava-hub-${process.env.STAGE || 'dev'}-activities`;
}

function getBucketName() {
  return process.env.RAW_BUCKET_NAME;
}

/**
 * Format S3 key for storing raw activity JSON.
 */
function getS3Key(athleteId, activityId) {
  if (!isValidId(athleteId) || !isValidId(activityId)) {
    throw new Error('Invalid athlete ID or activity ID for S3 key construction');
  }
  return `athletes/${athleteId}/activities/${activityId}.json`;
}

/**
 * Persist an activity: saves metadata to DynamoDB and full raw JSON payload to S3.
 * @param {string} athleteId - Strava Athlete ID
 * @param {Object} rawActivity - Raw Strava detailed activity JSON
 * @returns {Promise<Object>} The saved activity metadata item
 */
async function saveActivity(athleteId, rawActivity) {
  const athleteIdStr = String(athleteId || '');
  const activityIdStr = String(rawActivity?.id || '');

  if (!isValidId(athleteIdStr) || !isValidId(activityIdStr)) {
    throw new Error('Invalid athleteId or activityId format');
  }

  const tableName = getTableName();
  const bucketName = getBucketName();
  const s3Key = getS3Key(athleteIdStr, activityIdStr);
  const now = new Date().toISOString();

  // 1. Upload raw payload to S3
  if (bucketName) {
    try {
      const putS3Command = new PutObjectCommand({
        Bucket: bucketName,
        Key: s3Key,
        Body: JSON.stringify(rawActivity),
        ContentType: 'application/json',
      });
      await s3Client.send(putS3Command);
      logger.debug(
        { athleteId: athleteIdStr, activityId: activityIdStr, bucketName, s3Key },
        'Saved raw activity payload to S3'
      );
    } catch (s3Error) {
      logger.error(
        { athleteId: athleteIdStr, activityId: activityIdStr, bucketName, s3Key, errMessage: s3Error.message },
        'Failed to upload raw activity to S3'
      );
      throw s3Error;
    }
  }

  // 2. Extract indexed metadata for DynamoDB
  const metadataItem = {
    athleteId: athleteIdStr,
    activityId: activityIdStr,
    name: rawActivity.name || 'Untitled Activity',
    type: rawActivity.type || 'Workout',
    sportType: rawActivity.sport_type || rawActivity.type || 'Workout',
    startDate: rawActivity.start_date || now,
    startDateLocal: rawActivity.start_date_local || null,
    distance: typeof rawActivity.distance === 'number' ? rawActivity.distance : 0,
    movingTime: typeof rawActivity.moving_time === 'number' ? rawActivity.moving_time : 0,
    elapsedTime: typeof rawActivity.elapsed_time === 'number' ? rawActivity.elapsed_time : 0,
    totalElevationGain: typeof rawActivity.total_elevation_gain === 'number' ? rawActivity.total_elevation_gain : 0,
    averageSpeed: typeof rawActivity.average_speed === 'number' ? rawActivity.average_speed : 0,
    maxSpeed: typeof rawActivity.max_speed === 'number' ? rawActivity.max_speed : 0,
    hasHeartrate: !!rawActivity.has_heartrate,
    averageHeartrate: rawActivity.average_heartrate || null,
    maxHeartrate: rawActivity.max_heartrate || null,
    resourceState: rawActivity.resource_state || 3,
    // Store summary polyline directly in DynamoDB for instant route rendering
    summaryPolyline: rawActivity.map?.summary_polyline || null,
    s3Key,
    updatedAt: now,
  };

  // 3. Write metadata to DynamoDB
  try {
    const putDdbCommand = new PutCommand({
      TableName: tableName,
      Item: metadataItem,
    });
    await docClient.send(putDdbCommand);

    logger.info(
      { athleteId: athleteIdStr, activityId: activityIdStr, tableName },
      'Saved activity metadata to DynamoDB'
    );
    return metadataItem;
  } catch (ddbError) {
    logger.error(
      { athleteId: athleteIdStr, activityId: activityIdStr, tableName, errMessage: ddbError.message },
      'Failed to save activity metadata to DynamoDB'
    );
    throw ddbError;
  }
}

/**
 * Save a summary activity from historical backfill.
 * Condition: Does NOT overwrite existing detailed activities (resourceState: 3).
 * @param {string} athleteId
 * @param {Object} summaryActivity - Strava summary activity JSON
 */
async function saveSummaryActivity(athleteId, summaryActivity) {
  const athleteIdStr = String(athleteId || '');
  const activityIdStr = String(summaryActivity?.id || '');

  if (!isValidId(athleteIdStr) || !isValidId(activityIdStr)) {
    throw new Error('Invalid athleteId or activityId format');
  }

  const tableName = getTableName();
  const bucketName = getBucketName();
  const s3Key = getS3Key(athleteIdStr, activityIdStr);
  const now = new Date().toISOString();

  // Extract metadata
  const metadataItem = {
    athleteId: athleteIdStr,
    activityId: activityIdStr,
    name: summaryActivity.name || 'Untitled Activity',
    type: summaryActivity.type || 'Workout',
    sportType: summaryActivity.sport_type || summaryActivity.type || 'Workout',
    startDate: summaryActivity.start_date || now,
    startDateLocal: summaryActivity.start_date_local || null,
    distance: typeof summaryActivity.distance === 'number' ? summaryActivity.distance : 0,
    movingTime: typeof summaryActivity.moving_time === 'number' ? summaryActivity.moving_time : 0,
    elapsedTime: typeof summaryActivity.elapsed_time === 'number' ? summaryActivity.elapsed_time : 0,
    totalElevationGain: typeof summaryActivity.total_elevation_gain === 'number' ? summaryActivity.total_elevation_gain : 0,
    averageSpeed: typeof summaryActivity.average_speed === 'number' ? summaryActivity.average_speed : 0,
    maxSpeed: typeof summaryActivity.max_speed === 'number' ? summaryActivity.max_speed : 0,
    hasHeartrate: !!summaryActivity.has_heartrate,
    averageHeartrate: summaryActivity.average_heartrate || null,
    maxHeartrate: summaryActivity.max_heartrate || null,
    resourceState: summaryActivity.resource_state || 2,
    summaryPolyline: summaryActivity.map?.summary_polyline || null,
    s3Key,
    updatedAt: now,
  };

  // 1. Write to DynamoDB conditionally (do not downgrade existing detailed record)
  try {
    const putDdbCommand = new PutCommand({
      TableName: tableName,
      Item: metadataItem,
      ConditionExpression: 'attribute_not_exists(activityId) OR resourceState <= :maxResourceState',
      ExpressionAttributeValues: {
        ':maxResourceState': 2,
      },
    });
    await docClient.send(putDdbCommand);
    logger.debug({ athleteId: athleteIdStr, activityId: activityIdStr }, 'Saved summary activity to DynamoDB');
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
      logger.debug(
        { athleteId: athleteIdStr, activityId: activityIdStr },
        'Detailed activity already exists; preserved without downgrade'
      );
      return metadataItem;
    }
    logger.error({ athleteId: athleteIdStr, activityId: activityIdStr, errMessage: err.message }, 'Failed to save summary activity');
    throw err;
  }

  // 2. Upload summary JSON to S3
  if (bucketName) {
    try {
      const putS3Command = new PutObjectCommand({
        Bucket: bucketName,
        Key: s3Key,
        Body: JSON.stringify(summaryActivity),
        ContentType: 'application/json',
      });
      await s3Client.send(putS3Command);
    } catch (s3Err) {
      logger.warn({ athleteId: athleteIdStr, activityId: activityIdStr, errMessage: s3Err.message }, 'Failed to upload summary JSON to S3');
    }
  }

  return metadataItem;
}

/**
 * Get an activity by athleteId and activityId.
 * @param {string} athleteId
 * @param {string} activityId
 * @param {Object} [options]
 * @param {boolean} [options.includeRaw=false] - Whether to fetch full raw JSON from S3
 */
async function getActivity(athleteId, activityId, { includeRaw = false } = {}) {
  const athleteIdStr = String(athleteId);
  const activityIdStr = String(activityId);
  const tableName = getTableName();

  let metadata;
  try {
    const getCommand = new GetCommand({
      TableName: tableName,
      Key: {
        athleteId: athleteIdStr,
        activityId: activityIdStr,
      },
    });
    const result = await docClient.send(getCommand);
    metadata = result.Item;
  } catch (ddbError) {
    logger.error(
      { athleteId: athleteIdStr, activityId: activityIdStr, tableName, errMessage: ddbError.message },
      'Failed to fetch activity metadata from DynamoDB'
    );
    throw ddbError;
  }

  if (!metadata) {
    return null;
  }

  if (includeRaw && metadata.s3Key && getBucketName()) {
    try {
      const getS3Command = new GetObjectCommand({
        Bucket: getBucketName(),
        Key: metadata.s3Key,
      });
      const s3Response = await s3Client.send(getS3Command);
      const rawString = await s3Response.Body.transformToString();
      metadata.raw = JSON.parse(rawString);
    } catch (s3Error) {
      logger.warn(
        { athleteId: athleteIdStr, activityId: activityIdStr, s3Key: metadata.s3Key, errMessage: s3Error.message },
        'Failed to fetch raw activity JSON from S3; returning metadata only'
      );
    }
  }

  return metadata;
}

/**
 * List activities for an athlete using the AthleteStartDateIndex GSI.
 * @param {string} athleteId
 * @param {Object} [options]
 * @param {number} [options.limit=30]
 * @param {boolean} [options.scanIndexForward=false] - false for newest first
 */
async function listActivities(athleteId, { limit = 30, scanIndexForward = false } = {}) {
  const athleteIdStr = String(athleteId);
  const tableName = getTableName();

  try {
    const queryCommand = new QueryCommand({
      TableName: tableName,
      IndexName: 'AthleteStartDateIndex',
      KeyConditionExpression: 'athleteId = :athleteId',
      ExpressionAttributeValues: {
        ':athleteId': athleteIdStr,
      },
      ScanIndexForward: scanIndexForward,
      Limit: limit,
    });

    const result = await docClient.send(queryCommand);
    return {
      items: result.Items || [],
      count: result.Count || 0,
    };
  } catch (error) {
    logger.error(
      { athleteId: athleteIdStr, tableName, errMessage: error.message },
      'Failed to list activities from DynamoDB'
    );
    throw error;
  }
}

/**
 * Delete an activity from both DynamoDB and S3.
 * @param {string} athleteId
 * @param {string} activityId
 */
async function deleteActivity(athleteId, activityId) {
  const athleteIdStr = String(athleteId);
  const activityIdStr = String(activityId);
  const tableName = getTableName();
  const bucketName = getBucketName();
  const s3Key = getS3Key(athleteIdStr, activityIdStr);

  try {
    const deleteDdbCommand = new DeleteCommand({
      TableName: tableName,
      Key: {
        athleteId: athleteIdStr,
        activityId: activityIdStr,
      },
    });
    await docClient.send(deleteDdbCommand);
  } catch (ddbError) {
    logger.error(
      { athleteId: athleteIdStr, activityId: activityIdStr, tableName, errMessage: ddbError.message },
      'Failed to delete activity from DynamoDB'
    );
    throw ddbError;
  }

  if (bucketName) {
    try {
      const deleteS3Command = new DeleteObjectCommand({
        Bucket: bucketName,
        Key: s3Key,
      });
      await s3Client.send(deleteS3Command);
    } catch (s3Error) {
      logger.warn(
        { athleteId: athleteIdStr, activityId: activityIdStr, s3Key, errMessage: s3Error.message },
        'Failed to delete raw activity object from S3'
      );
    }
  }

  logger.info({ athleteId: athleteIdStr, activityId: activityIdStr }, 'Deleted activity');
  return true;
}

module.exports = {
  saveActivity,
  saveSummaryActivity,
  getActivity,
  listActivities,
  deleteActivity,
  getS3Key,
  isValidId,
  docClient,
  s3Client,
};
