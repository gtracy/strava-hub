const { mockClient } = require('aws-sdk-client-mock');
const { EventBridgeClient, PutEventsCommand } = require('@aws-sdk/client-eventbridge');
const eventbridgeService = require('../services/eventbridge');

const ebMock = mockClient(EventBridgeClient);

describe('EventBridge Service', () => {
  beforeEach(() => {
    ebMock.reset();
    process.env.EVENT_BUS_NAME = 'strava-hub-dev-bus';
  });

  afterAll(() => {
    delete process.env.EVENT_BUS_NAME;
  });

  test('publishes ActivityCreated event with full detail payload', async () => {
    ebMock.on(PutEventsCommand).resolves({
      Entries: [{ EventId: 'evt-123' }],
    });

    const eventId = await eventbridgeService.publishActivityEvent({
      athleteId: '12345',
      activityId: '999',
      aspectType: 'create',
      metadata: {
        name: 'Morning Ride',
        type: 'Ride',
        distance: 25000,
        summaryPolyline: 'polyline_string',
        s3Key: 'athletes/12345/activities/999.json',
      },
    });

    expect(eventId).toBe('evt-123');
    const calls = ebMock.commandCalls(PutEventsCommand);
    expect(calls).toHaveLength(1);

    const entry = calls[0].args[0].input.Entries[0];
    expect(entry.EventBusName).toBe('strava-hub-dev-bus');
    expect(entry.Source).toBe('strava.hub.activity');
    expect(entry.DetailType).toBe('ActivityCreated');

    const detail = JSON.parse(entry.Detail);
    expect(detail.athleteId).toBe('12345');
    expect(detail.activityId).toBe('999');
    expect(detail.name).toBe('Morning Ride');
    expect(detail.summaryPolyline).toBe('polyline_string');
  });

  test('maps aspectType correctly for update and delete', () => {
    expect(eventbridgeService.getDetailType('create')).toBe('ActivityCreated');
    expect(eventbridgeService.getDetailType('update')).toBe('ActivityUpdated');
    expect(eventbridgeService.getDetailType('delete')).toBe('ActivityDeleted');
    expect(eventbridgeService.getDetailType('unknown')).toBe('ActivityChanged');
  });

  test('throws error if EventBridge returns FailedEntryCount', async () => {
    ebMock.on(PutEventsCommand).resolves({
      FailedEntryCount: 1,
      Entries: [{ ErrorCode: 'InternalFailure', ErrorMessage: 'Bus not ready' }],
    });

    await expect(
      eventbridgeService.publishActivityEvent({
        athleteId: '12345',
        activityId: '999',
        aspectType: 'create',
      })
    ).rejects.toThrow('Failed to publish event to EventBridge bus');
  });
});
