const jwt = require('jsonwebtoken');
const appHandler = require('../app');
const athleteRepository = require('../repositories/athlete-repository');
const activityRepository = require('../repositories/activity-repository');
const stravaService = require('../services/strava');
const queueService = require('../services/queue');
const appRegistry = require('../services/app-registry');

describe('API Gateway App Handler', () => {
  const JWT_SECRET = 'test-secret-at-least-32-chars-long';
  const VERIFY_TOKEN = 'test-verify-token';

  beforeEach(() => {
    jest.restoreAllMocks();
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.STRAVA_VERIFY_TOKEN = VERIFY_TOKEN;
  });

  afterAll(() => {
    delete process.env.JWT_SECRET;
    delete process.env.STRAVA_VERIFY_TOKEN;
  });

  function createAuthHeader(athleteId = '12345') {
    const token = jwt.sign({ athleteId }, JWT_SECRET, { expiresIn: '1h' });
    return { authorization: `Bearer ${token}` };
  }

  describe('GET /webhook (Verification Handshake)', () => {
    test('returns 200 and challenge when token matches', async () => {
      const event = {
        routeKey: 'GET /webhook',
        queryStringParameters: {
          'hub.mode': 'subscribe',
          'hub.verify_token': VERIFY_TOKEN,
          'hub.challenge': 'challenge-token-123',
        },
      };

      const response = await appHandler.handler(event);
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ 'hub.challenge': 'challenge-token-123' });
    });

    test('returns 403 when token mismatch', async () => {
      const event = {
        routeKey: 'GET /webhook',
        queryStringParameters: {
          'hub.mode': 'subscribe',
          'hub.verify_token': 'wrong-token',
          'hub.challenge': 'challenge-token-123',
        },
      };

      const response = await appHandler.handler(event);
      expect(response.statusCode).toBe(403);
    });
  });

  describe('POST /webhook (Event Ingestion)', () => {
    test('enqueues activity sync event', async () => {
      const enqueueSyncSpy = jest.spyOn(queueService, 'enqueueActivitySync').mockResolvedValueOnce('msg-1');

      const event = {
        routeKey: 'POST /webhook',
        body: JSON.stringify({
          object_type: 'activity',
          object_id: 99999,
          aspect_type: 'create',
          owner_id: 12345,
          updates: {},
        }),
      };

      const response = await appHandler.handler(event);
      expect(response.statusCode).toBe(200);
      expect(enqueueSyncSpy).toHaveBeenCalledWith(
        12345,
        99999,
        'create',
        {}
      );
    });

    test('handles athlete deauthorization by deleting athlete record', async () => {
      const deleteAthleteSpy = jest.spyOn(athleteRepository, 'deleteAthlete').mockResolvedValueOnce(true);

      const event = {
        routeKey: 'POST /webhook',
        body: JSON.stringify({
          object_type: 'athlete',
          object_id: 12345,
          owner_id: 12345,
          updates: { authorized: 'false' },
        }),
      };

      const response = await appHandler.handler(event);
      expect(response.statusCode).toBe(200);
      expect(deleteAthleteSpy).toHaveBeenCalledWith(12345);
    });
  });

  describe('POST /auth/strava (OAuth Code Exchange)', () => {
    test('exchanges code, saves athlete, enqueues 60-day sync, and returns JWT', async () => {
      jest.spyOn(stravaService, 'exchangeCode').mockResolvedValueOnce({
        access_token: 'act-123',
        refresh_token: 'ref-123',
        expires_at: 1725600000,
        athlete: {
          id: 12345,
          firstname: 'Greg',
          lastname: 'Tracy',
          profile: 'https://example.com/avatar.jpg',
        },
      });

      jest.spyOn(athleteRepository, 'saveAthlete').mockResolvedValueOnce({
        athleteId: '12345',
        firstname: 'Greg',
        lastname: 'Tracy',
        profile: 'https://example.com/avatar.jpg',
        totalActivities: 0,
      });

      const enqueueFetchSpy = jest.spyOn(queueService, 'enqueueActivityFetch').mockResolvedValueOnce('fetch-msg-1');

      const event = {
        routeKey: 'POST /auth/strava',
        body: JSON.stringify({ code: 'auth-code-xyz' }),
      };

      const response = await appHandler.handler(event);
      expect(response.statusCode).toBe(200);
      const parsed = JSON.parse(response.body);

      expect(parsed.athlete.athleteId).toBe('12345');
      expect(parsed.athlete.firstname).toBe('Greg');
      expect(parsed.token).toBeDefined();

      // Initial 60-day historical backfill check
      expect(enqueueFetchSpy).toHaveBeenCalledWith('12345', 60);

      // Verify returned JWT is valid
      const decoded = jwt.verify(parsed.token, JWT_SECRET);
      expect(decoded.athleteId).toBe('12345');
    });

    test('returns 400 when code is missing', async () => {
      const event = {
        routeKey: 'POST /auth/strava',
        body: JSON.stringify({}),
      };

      const response = await appHandler.handler(event);
      expect(response.statusCode).toBe(400);
    });
  });

  describe('GET /user/status', () => {
    test('returns athlete status for authenticated user', async () => {
      jest.spyOn(athleteRepository, 'getAthlete').mockResolvedValueOnce({
        athleteId: '12345',
        firstname: 'Greg',
        lastname: 'Tracy',
        totalActivities: 12,
        lastSyncAt: '2026-09-06T12:00:00Z',
      });

      jest.spyOn(activityRepository, 'listActivities').mockResolvedValueOnce({ count: 12, items: [] });

      const event = {
        routeKey: 'GET /user/status',
        headers: createAuthHeader('12345'),
      };

      const response = await appHandler.handler(event);
      expect(response.statusCode).toBe(200);
      const parsed = JSON.parse(response.body);
      expect(parsed.athleteId).toBe('12345');
      expect(parsed.totalActivities).toBe(12);
      expect(parsed.connected).toBe(true);
    });

    test('returns 401 when Authorization header is missing', async () => {
      const event = {
        routeKey: 'GET /user/status',
        headers: {},
      };

      const response = await appHandler.handler(event);
      expect(response.statusCode).toBe(401);
    });
  });

  describe('POST /user/sync', () => {
    test('enqueues historical sync for authenticated user', async () => {
      const enqueueFetchSpy = jest.spyOn(queueService, 'enqueueActivityFetch').mockResolvedValueOnce('msg-fetch');

      const event = {
        routeKey: 'POST /user/sync',
        headers: createAuthHeader('12345'),
        body: JSON.stringify({ days: 90 }),
      };

      const response = await appHandler.handler(event);
      expect(response.statusCode).toBe(200);
      expect(enqueueFetchSpy).toHaveBeenCalledWith('12345', 90);
    });
  });

  describe('DELETE /user', () => {
    test('deauthorizes token and deletes athlete record', async () => {
      jest.spyOn(athleteRepository, 'getAthlete').mockResolvedValueOnce({
        athleteId: '12345',
        accessToken: 'valid-access-token',
      });
      const deauthSpy = jest.spyOn(stravaService, 'deauthorize').mockResolvedValueOnce(true);
      const deleteAthleteSpy = jest.spyOn(athleteRepository, 'deleteAthlete').mockResolvedValueOnce(true);

      const event = {
        routeKey: 'DELETE /user',
        headers: createAuthHeader('12345'),
      };

      const response = await appHandler.handler(event);
      expect(response.statusCode).toBe(200);
      expect(deauthSpy).toHaveBeenCalledWith('valid-access-token');
      expect(deleteAthleteSpy).toHaveBeenCalledWith('12345');
    });
  });

  describe('GET /api/apps', () => {
    test('returns discovered mini-apps', async () => {
      jest.spyOn(appRegistry, 'getRegisteredApps').mockReturnValueOnce([
        { id: 'hello-world', name: 'Hello World', capabilities: ['activity.created'] },
      ]);

      const event = {
        routeKey: 'GET /api/apps',
      };

      const response = await appHandler.handler(event);
      expect(response.statusCode).toBe(200);
      const parsed = JSON.parse(response.body);
      expect(parsed.apps).toHaveLength(1);
      expect(parsed.apps[0].id).toBe('hello-world');
    });
  });
});
