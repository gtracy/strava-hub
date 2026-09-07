const { handler, formatDistance, formatDuration } = require('../src/handler');

describe('Hello World Consumer Handler', () => {
  describe('formatDistance', () => {
    test('converts meters to kilometers and miles accurately', () => {
      const result = formatDistance(10000); // 10k
      expect(result.km).toBe('10.00');
      expect(result.miles).toBe('6.21');
    });

    test('handles zero distance gracefully', () => {
      const result = formatDistance(0);
      expect(result.km).toBe('0.00');
      expect(result.miles).toBe('0.00');
    });
  });

  describe('formatDuration', () => {
    test('formats duration under 1 hour in minutes and seconds', () => {
      expect(formatDuration(1845)).toBe('30m 45s');
    });

    test('formats duration over 1 hour in hours and minutes', () => {
      expect(formatDuration(3665)).toBe('1h 1m');
      expect(formatDuration(7320)).toBe('2h 2m');
    });
  });

  describe('handler', () => {
    test('processes SQS-wrapped EventBridge event and returns cheer response', async () => {
      const eventBridgeDetail = {
        athleteId: '12345678',
        activityId: '987654321',
        aspectType: 'create',
        name: 'Sunday Morning Run',
        type: 'Run',
        distance: 8500,
        movingTime: 2700,
        summaryPolyline: 'encoded_track_polyline',
        s3Key: 'athletes/12345678/activities/987654321.json',
      };

      const sqsEvent = {
        Records: [
          {
            body: JSON.stringify({
              id: 'event-uuid-1',
              source: 'strava.hub.activity',
              'detail-type': 'ActivityCreated',
              detail: eventBridgeDetail,
            }),
          },
        ],
      };

      const response = await handler(sqsEvent);
      expect(response.processed).toBe(1);
      expect(response.results).toHaveLength(1);

      const result = response.results[0];
      expect(result.athleteId).toBe('12345678');
      expect(result.activityId).toBe('987654321');
      expect(result.cheer).toContain('Athlete 12345678 completed a Run ("Sunday Morning Run")');
      expect(result.cheer).toContain('8.50 km');
    });

    test('ignores malformed SQS records without failing entire batch', async () => {
      const sqsEvent = {
        Records: [
          { body: 'invalid-json-string' },
        ],
      };

      const response = await handler(sqsEvent);
      expect(response.processed).toBe(0);
    });
  });
});
