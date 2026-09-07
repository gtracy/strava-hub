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

  describe('Security and Headers', () => {
    test('enforces minimum 32 character JWT_SECRET', () => {
      process.env.JWT_SECRET = 'too-short';
      expect(() => appHandler.getJwtSecret()).toThrow('at least 32 characters');

      delete process.env.JWT_SECRET;
      expect(() => appHandler.getJwtSecret()).toThrow('JWT_SECRET environment variable must be set');
    });

    test('attaches security headers to all responses', async () => {
      const response = await appHandler.handler({ routeKey: 'GET /api/apps' });
      expect(response.headers['X-Content-Type-Options']).toBe('nosniff');
      expect(response.headers['X-Frame-Options']).toBe('DENY');
      expect(response.headers['Strict-Transport-Security']).toBe('max-age=31536000; includeSubDomains');
      expect(response.headers['Cache-Control']).toBe('no-store, max-age=0');
    });

    test('timingSafeCompare works correctly and safely', () => {
      expect(appHandler.timingSafeCompare('secret-token', 'secret-token')).toBe(true);
      expect(appHandler.timingSafeCompare('secret-token', 'wrong-token')).toBe(false);
      expect(appHandler.timingSafeCompare('secret-token', 'secret-token-longer')).toBe(false);
      expect(appHandler.timingSafeCompare(null, 'secret-token')).toBe(false);
    });
  });

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
    test('enqueues activity sync event when valid token is provided', async () => {
      const enqueueSyncSpy = jest.spyOn(queueService, 'enqueueActivitySync').mockResolvedValueOnce('msg-1');

      const event = {
        routeKey: 'POST /webhook',
        queryStringParameters: { token: VERIFY_TOKEN },
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
        '12345',
        '99999',
        'create',
        {}
      );
    });

    test('rejects POST /webhook with 403 when token is missing or invalid', async () => {
      const event = {
        routeKey: 'POST /webhook',
        queryStringParameters: { token: 'invalid-token' },
        body: JSON.stringify({
          object_type: 'activity',
          object_id: 99999,
          aspect_type: 'create',
          owner_id: 12345,
        }),
      };

      const response = await appHandler.handler(event);
      expect(response.statusCode).toBe(403);
    });

    test('handles athlete deauthorization by deleting existing athlete record', async () => {
      jest.spyOn(athleteRepository, 'getAthlete').mockResolvedValueOnce({ athleteId: '12345' });
      const deleteAthleteSpy = jest.spyOn(athleteRepository, 'deleteAthlete').mockResolvedValueOnce(true);

      const event = {
        routeKey: 'POST /webhook',
        queryStringParameters: { token: VERIFY_TOKEN },
        body: JSON.stringify({
          object_type: 'athlete',
          object_id: 12345,
          owner_id: 12345,
          updates: { authorized: 'false' },
        }),
      };

      const response = await appHandler.handler(event);
      expect(response.statusCode).toBe(200);
      expect(deleteAthleteSpy).toHaveBeenCalledWith('12345');
    });

    test('rejects invalid identifier format in activity event', async () => {
      const event = {
        routeKey: 'POST /webhook',
        queryStringParameters: { token: VERIFY_TOKEN },
        body: JSON.stringify({
          object_type: 'activity',
          object_id: '../malicious-path',
          aspect_type: 'create',
          owner_id: 12345,
        }),
      };

      const response = await appHandler.handler(event);
      expect(response.statusCode).toBe(400);
    });
  });

  describe('POST /auth/strava (OAuth Code Exchange)', () => {
    test('exchanges code, saves athlete, acquires sync lock, and returns JWT', async () => {
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

      const lockSpy = jest.spyOn(athleteRepository, 'acquireSyncLock').mockResolvedValueOnce(true);
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

      expect(lockSpy).toHaveBeenCalledWith('12345', expect.any(String), 60);
      expect(enqueueFetchSpy).toHaveBeenCalledWith('12345', 60, expect.any(String));

      // Verify returned JWT is signed with HS256
      const decoded = jwt.verify(parsed.token, JWT_SECRET, { algorithms: ['HS256'] });
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
    test('returns athlete status including tier and syncJob for authenticated user', async () => {
      jest.spyOn(athleteRepository, 'getAthlete').mockResolvedValueOnce({
        athleteId: '12345',
        firstname: 'Greg',
        lastname: 'Tracy',
        totalActivities: 12,
        lastSyncAt: '2026-09-06T12:00:00Z',
        tier: 'free',
        syncJob: {
          jobId: 'job-1',
          status: 'completed',
          count: 12,
        },
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
      expect(parsed.tier).toBe('free');
      expect(parsed.syncJob.status).toBe('completed');
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
    test('acquires sync lock and enqueues historical sync returning 202 Accepted', async () => {
      const lockSpy = jest.spyOn(athleteRepository, 'acquireSyncLock').mockResolvedValueOnce(true);
      const enqueueFetchSpy = jest.spyOn(queueService, 'enqueueActivityFetch').mockResolvedValueOnce('msg-fetch');

      const event = {
        routeKey: 'POST /user/sync',
        headers: createAuthHeader('12345'),
        body: JSON.stringify({ days: 90 }),
      };

      const response = await appHandler.handler(event);
      expect(response.statusCode).toBe(202);
      const parsed = JSON.parse(response.body);
      expect(parsed.success).toBe(true);
      expect(parsed.jobId).toBeDefined();
      expect(parsed.days).toBe(90);

      expect(lockSpy).toHaveBeenCalledWith('12345', expect.any(String), 90);
      expect(enqueueFetchSpy).toHaveBeenCalledWith('12345', 90, expect.any(String));
    });

    test('returns 409 Conflict when sync lock cannot be acquired (already syncing)', async () => {
      jest.spyOn(athleteRepository, 'acquireSyncLock').mockResolvedValueOnce(false);

      const event = {
        routeKey: 'POST /user/sync',
        headers: createAuthHeader('12345'),
        body: JSON.stringify({ days: 60 }),
      };

      const response = await appHandler.handler(event);
      expect(response.statusCode).toBe(409);
      const parsed = JSON.parse(response.body);
      expect(parsed.error).toMatch(/Sync already in progress/i);
    });

    test('returns 400 when days exceeds 365 with guidance message', async () => {
      const event = {
        routeKey: 'POST /user/sync',
        headers: createAuthHeader('12345'),
        body: JSON.stringify({ days: 1000 }),
      };

      const response = await appHandler.handler(event);
      expect(response.statusCode).toBe(400);
      const parsed = JSON.parse(response.body);
      expect(parsed.error).toMatch(/Bulk ZIP Import/i);
    });

    test('returns 400 when days is invalid or negative', async () => {
      const event = {
        routeKey: 'POST /user/sync',
        headers: createAuthHeader('12345'),
        body: JSON.stringify({ days: -5 }),
      };

      const response = await appHandler.handler(event);
      expect(response.statusCode).toBe(400);
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
