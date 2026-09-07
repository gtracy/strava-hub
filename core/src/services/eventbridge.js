const { EventBridgeClient, PutEventsCommand } = require('@aws-sdk/client-eventbridge');
const logger = require('../logger');

const region = process.env.AWS_REGION || 'us-east-2';
const ebClient = new EventBridgeClient({ region });

function getEventBusName() {
  return process.env.EVENT_BUS_NAME || `strava-hub-${process.env.STAGE || 'dev'}-bus`;
}

/**
 * Map Strava aspectType to EventBridge DetailType.
 */
function getDetailType(aspectType) {
  switch (aspectType) {
    case 'create':
      return 'ActivityCreated';
    case 'update':
      return 'ActivityUpdated';
    case 'delete':
      return 'ActivityDeleted';
    default:
      return 'ActivityChanged';
  }
}

/**
 * Publish an activity event to the custom EventBridge bus.
 * @param {Object} params
 * @param {string} params.athleteId
 * @param {string|number} params.activityId
 * @param {'create'|'update'|'delete'} params.aspectType
 * @param {Object} [params.metadata] - Activity metadata (from DynamoDB)
 * @param {string} [params.busName] - Optional override
 */
async function publishActivityEvent({
  athleteId,
  activityId,
  aspectType,
  metadata = {},
  busName = getEventBusName(),
}) {
  const athleteIdStr = String(athleteId);
  const activityIdStr = String(activityId);
  const detailType = getDetailType(aspectType);
  const now = new Date().toISOString();

  const detailPayload = {
    athleteId: athleteIdStr,
    activityId: activityIdStr,
    aspectType,
    name: metadata.name || null,
    type: metadata.type || null,
    sportType: metadata.sportType || null,
    distance: metadata.distance || 0,
    movingTime: metadata.movingTime || 0,
    startDate: metadata.startDate || null,
    summaryPolyline: metadata.summaryPolyline || null,
    s3Key: metadata.s3Key || null,
    timestamp: now,
  };

  try {
    const command = new PutEventsCommand({
      Entries: [
        {
          EventBusName: busName,
          Source: 'strava.hub.activity',
          DetailType: detailType,
          Detail: JSON.stringify(detailPayload),
          Time: new Date(),
        },
      ],
    });

    const response = await ebClient.send(command);

    if (response.FailedEntryCount && response.FailedEntryCount > 0) {
      logger.error(
        {
          athleteId: athleteIdStr,
          activityId: activityIdStr,
          busName,
          failedEntries: response.Entries,
        },
        'EventBridge rejected event entry'
      );
      throw new Error(`Failed to publish event to EventBridge bus: ${busName}`);
    }

    const eventId = response.Entries?.[0]?.EventId;
    logger.info(
      {
        athleteId: athleteIdStr,
        activityId: activityIdStr,
        detailType,
        busName,
        eventId,
      },
      'Successfully published activity event to EventBridge'
    );
    return eventId;
  } catch (error) {
    logger.error(
      {
        athleteId: athleteIdStr,
        activityId: activityIdStr,
        busName,
        detailType,
        errMessage: error.message,
      },
      'Failed to publish event to EventBridge'
    );
    throw error;
  }
}

module.exports = {
  publishActivityEvent,
  getDetailType,
  ebClient,
};
