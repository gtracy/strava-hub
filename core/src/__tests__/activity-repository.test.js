const { mockClient } = require('aws-sdk-client-mock');
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
const activityRepository = require('../repositories/activity-repository');

const ddbMock = mockClient(DynamoDBDocumentClient);
const s3Mock = mockClient(S3Client);

describe('Activity Repository', () => {
  beforeEach(() => {
    ddbMock.reset();
    s3Mock.reset();
    process.env.ACTIVITIES_TABLE_NAME = 'strava-hub-dev-activities';
    process.env.RAW_BUCKET_NAME = 'strava-hub-dev-raw-data-123456789-us-east-2';
  });

  afterAll(() => {
    delete process.env.ACTIVITIES_TABLE_NAME;
    delete process.env.RAW_BUCKET_NAME;
  });

  describe('saveActivity', () => {
    test('uploads raw JSON to S3 and writes indexed metadata with polyline to DynamoDB', async () => {
      s3Mock.on(PutObjectCommand).resolves({});
      ddbMock.on(PutCommand).resolves({});

      const rawStravaActivity = {
        id: 987654321,
        name: 'Morning Trail Run',
        type: 'Run',
        sport_type: 'TrailRun',
        start_date: '2026-09-06T14:30:00Z',
        start_date_local: '2026-09-06T08:30:00',
        distance: 8500.5,
        moving_time: 2700,
        elapsed_time: 2850,
        total_elevation_gain: 245.0,
        average_speed: 3.15,
        max_speed: 4.8,
        has_heartrate: true,
        average_heartrate: 152.4,
        max_heartrate: 174,
        map: {
          id: 'a987654321',
          summary_polyline: '}_p~Ff~v|U_@_@e...',
          polyline: 'detailed_full_gps_polyline_string_with_thousands_of_points...',
        },
      };

      const savedMetadata = await activityRepository.saveActivity('12345678', rawStravaActivity);

      expect(savedMetadata.athleteId).toBe('12345678');
      expect(savedMetadata.activityId).toBe('987654321');
      expect(savedMetadata.name).toBe('Morning Trail Run');
      expect(savedMetadata.type).toBe('Run');
      expect(savedMetadata.sportType).toBe('TrailRun');
      expect(savedMetadata.distance).toBe(8500.5);
      expect(savedMetadata.summaryPolyline).toBe('}_p~Ff~v|U_@_@e...');
      expect(savedMetadata.s3Key).toBe('athletes/12345678/activities/987654321.json');

      // Verify S3 call
      const s3Calls = s3Mock.commandCalls(PutObjectCommand);
      expect(s3Calls).toHaveLength(1);
      expect(s3Calls[0].args[0].input).toEqual({
        Bucket: 'strava-hub-dev-raw-data-123456789-us-east-2',
        Key: 'athletes/12345678/activities/987654321.json',
        Body: JSON.stringify(rawStravaActivity),
        ContentType: 'application/json',
      });

      // Verify DynamoDB call
      const ddbCalls = ddbMock.commandCalls(PutCommand);
      expect(ddbCalls).toHaveLength(1);
      expect(ddbCalls[0].args[0].input.Item.summaryPolyline).toBe('}_p~Ff~v|U_@_@e...');
    });
  });

  describe('getActivity', () => {
    test('returns metadata from DynamoDB', async () => {
      ddbMock.on(GetCommand).resolves({
        Item: {
          athleteId: '12345678',
          activityId: '987654321',
          name: 'Morning Ride',
          s3Key: 'athletes/12345678/activities/987654321.json',
        },
      });

      const activity = await activityRepository.getActivity('12345678', '987654321');
      expect(activity).toBeDefined();
      expect(activity.name).toBe('Morning Ride');
      expect(activity.raw).toBeUndefined();
      expect(s3Mock.calls()).toHaveLength(0);
    });

    test('fetches raw JSON payload from S3 when includeRaw is true', async () => {
      ddbMock.on(GetCommand).resolves({
        Item: {
          athleteId: '12345678',
          activityId: '987654321',
          name: 'Morning Ride',
          s3Key: 'athletes/12345678/activities/987654321.json',
        },
      });

      const rawPayload = {
        id: 987654321,
        name: 'Morning Ride',
        map: { polyline: 'full_polyline_here' },
      };

      // Mock S3 stream response
      s3Mock.on(GetObjectCommand).resolves({
        Body: {
          transformToString: async () => JSON.stringify(rawPayload),
        },
      });

      const activity = await activityRepository.getActivity('12345678', '987654321', {
        includeRaw: true,
      });

      expect(activity.name).toBe('Morning Ride');
      expect(activity.raw).toEqual(rawPayload);
      expect(s3Mock.calls()).toHaveLength(1);
    });

    test('returns null if activity not found in DynamoDB', async () => {
      ddbMock.on(GetCommand).resolves({ Item: undefined });
      const activity = await activityRepository.getActivity('12345678', '999');
      expect(activity).toBeNull();
    });
  });

  describe('listActivities', () => {
    test('queries DynamoDB GSI AthleteStartDateIndex for athlete activities', async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [
          { athleteId: '12345678', activityId: 'act2', startDate: '2026-09-06T12:00:00Z' },
          { athleteId: '12345678', activityId: 'act1', startDate: '2026-09-05T12:00:00Z' },
        ],
        Count: 2,
      });

      const result = await activityRepository.listActivities('12345678', { limit: 10 });
      expect(result.count).toBe(2);
      expect(result.items).toHaveLength(2);

      const queryCalls = ddbMock.commandCalls(QueryCommand);
      expect(queryCalls[0].args[0].input).toMatchObject({
        TableName: 'strava-hub-dev-activities',
        IndexName: 'AthleteStartDateIndex',
        KeyConditionExpression: 'athleteId = :athleteId',
      });
    });
  });

  describe('deleteActivity', () => {
    test('deletes activity from both DynamoDB and S3', async () => {
      ddbMock.on(DeleteCommand).resolves({});
      s3Mock.on(DeleteObjectCommand).resolves({});

      const result = await activityRepository.deleteActivity('12345678', '987654321');
      expect(result).toBe(true);

      expect(ddbMock.calls()).toHaveLength(1);
      expect(s3Mock.calls()).toHaveLength(1);
      expect(s3Mock.commandCalls(DeleteObjectCommand)[0].args[0].input.Key).toBe(
        'athletes/12345678/activities/987654321.json'
      );
    });
  });
});
