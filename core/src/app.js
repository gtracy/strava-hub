const jwt = require('jsonwebtoken');
const logger = require('./logger');
const athleteRepository = require('./repositories/athlete-repository');
const activityRepository = require('./repositories/activity-repository');
const stravaService = require('./services/strava');
const queueService = require('./services/queue');
const appRegistry = require('./services/app-registry');

function getJwtSecret() {
  return process.env.JWT_SECRET || 'dev-secret-key-at-least-32-chars-long';
}

/**
 * Verify JWT session from Authorization header.
 * @returns {string} athleteId
 */
function verifySession(headers) {
  const authHeader = headers?.authorization || headers?.Authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    const err = new Error('Missing or invalid Authorization header');
    err.statusCode = 401;
    throw err;
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, getJwtSecret());
    return String(decoded.athleteId);
  } catch (jwtErr) {
    const err = new Error('Invalid or expired session token');
    err.statusCode = 401;
    throw err;
  }
}

/**
 * Build CORS and JSON response headers.
 */
function buildResponse(statusCode, body = {}) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

/**
 * Global error handler returning sanitized response.
 */
function handleError(error, context = {}) {
  const statusCode = error.statusCode || (error.message.includes('Unauthorized') ? 401 : 500);

  logger.error(
    { errMessage: error.message, statusCode, ...context },
    'Unhandled API Error'
  );

  return buildResponse(statusCode, {
    error: statusCode === 500 ? 'Internal Server Error' : error.message,
  });
}

/**
 * API Gateway HTTP Lambda Handler.
 */
async function handler(event) {
  const routeKey = event.routeKey || `${event.httpMethod || 'GET'} ${event.path || '/'}`;
  const headers = event.headers || {};
  const rawQuery = event.rawQueryString || '';
  const queryStringParameters = event.queryStringParameters || {};

  logger.debug({ routeKey, hasBody: !!event.body }, 'Incoming API request');

  try {
    // 0. CORS Preflight
    if (routeKey.startsWith('OPTIONS')) {
      return buildResponse(200, '');
    }

    // 1. GET /webhook - Handshake Verification from Strava
    if (routeKey === 'GET /webhook') {
      const params = new URLSearchParams(rawQuery);
      const mode = queryStringParameters['hub.mode'] || params.get('hub.mode');
      const verifyToken = queryStringParameters['hub.verify_token'] || params.get('hub.verify_token');
      const challenge = queryStringParameters['hub.challenge'] || params.get('hub.challenge');

      const expectedToken = process.env.STRAVA_VERIFY_TOKEN;

      if (mode === 'subscribe' && verifyToken && verifyToken === expectedToken) {
        logger.info('Strava webhook subscription handshake verified');
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 'hub.challenge': challenge }),
        };
      }

      logger.warn(
        { mode, verifyTokenMatches: verifyToken === expectedToken },
        'Strava webhook verification failed'
      );
      return buildResponse(403, { error: 'Forbidden' });
    }

    // 2. POST /webhook - Event Ingestion from Strava
    if (routeKey === 'POST /webhook') {
      let payload;
      try {
        payload = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
      } catch (parseErr) {
        logger.error({ errMessage: parseErr.message }, 'Malformed JSON in webhook body');
        return buildResponse(400, { error: 'Invalid JSON' });
      }

      const { object_type, object_id, aspect_type, owner_id, updates } = payload || {};
      logger.info(
        { object_type, object_id, aspect_type, owner_id },
        'Received Strava webhook notification'
      );

      // Handle athlete events (e.g. app deauthorization)
      if (object_type === 'athlete') {
        if (updates?.authorized === 'false') {
          logger.info({ owner_id }, 'Athlete deauthorized app from Strava');
          await athleteRepository.deleteAthlete(owner_id);
        }
        return buildResponse(200, { status: 'OK' });
      }

      // Handle activity events (create, update, delete)
      if (object_type === 'activity') {
        await queueService.enqueueActivitySync(owner_id, object_id, aspect_type, updates);
        return buildResponse(200, { status: 'OK' });
      }

      // Non-activity event; acknowledge OK
      return buildResponse(200, { status: 'Ignored' });
    }

    // 3. POST /auth/strava - Complete OAuth flow
    if (routeKey === 'POST /auth/strava') {
      const body = typeof event.body === 'string' ? JSON.parse(event.body || '{}') : event.body;
      const { code } = body || {};

      if (!code) {
        return buildResponse(400, { error: 'Missing code parameter' });
      }

      // Exchange code with Strava
      const tokenData = await stravaService.exchangeCode(code);
      const athleteData = tokenData.athlete;

      if (!athleteData || !athleteData.id) {
        return buildResponse(502, { error: 'Invalid athlete data in Strava response' });
      }

      const athleteIdStr = String(athleteData.id);

      // Save athlete profile and encrypted tokens
      const savedAthlete = await athleteRepository.saveAthlete({
        athleteId: athleteIdStr,
        firstname: athleteData.firstname,
        lastname: athleteData.lastname,
        profile: athleteData.profile,
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token,
        expiresAt: tokenData.expires_at,
        city: athleteData.city,
        state: athleteData.state,
        country: athleteData.country,
        measurementPreference: athleteData.measurement_preference,
      });

      // Trigger automatic 60-day historical backfill
      try {
        await queueService.enqueueActivityFetch(athleteIdStr, 60);
      } catch (queueErr) {
        logger.warn(
          { athleteId: athleteIdStr, errMessage: queueErr.message },
          'Failed to trigger initial backfill on sign-in'
        );
      }

      // Generate signed JWT session token (14-day expiry)
      const sessionToken = jwt.sign(
        {
          athleteId: athleteIdStr,
          firstname: athleteData.firstname,
          lastname: athleteData.lastname,
        },
        getJwtSecret(),
        { expiresIn: '14d' }
      );

      return buildResponse(200, {
        athlete: {
          athleteId: athleteIdStr,
          firstname: savedAthlete.firstname,
          lastname: savedAthlete.lastname,
          profile: savedAthlete.profile,
          lastSyncAt: savedAthlete.lastSyncAt,
          totalActivities: savedAthlete.totalActivities || 0,
        },
        token: sessionToken,
      });
    }

    // 4. GET /user/status - Athlete session & sync state
    if (routeKey === 'GET /user/status') {
      const athleteId = verifySession(headers);
      const athlete = await athleteRepository.getAthlete(athleteId, { decryptTokens: false });

      if (!athlete) {
        return buildResponse(404, { error: 'Athlete record not found' });
      }

      const recentActivities = await activityRepository.listActivities(athleteId, { limit: 1 });

      return buildResponse(200, {
        athleteId,
        firstname: athlete.firstname,
        lastname: athlete.lastname,
        profile: athlete.profile,
        city: athlete.city,
        country: athlete.country,
        lastSyncAt: athlete.lastSyncAt,
        totalActivities: athlete.totalActivities || recentActivities.count,
        connected: true,
      });
    }

    // 5. POST /user/sync - Request manual backfill
    if (routeKey === 'POST /user/sync') {
      const athleteId = verifySession(headers);
      const body = typeof event.body === 'string' ? JSON.parse(event.body || '{}') : event.body;
      const days = Number(body?.days) || 60;

      await queueService.enqueueActivityFetch(athleteId, days);

      return buildResponse(200, {
        success: true,
        message: `Queued sync for the last ${days} days`,
      });
    }

    // 6. DELETE /user - Revoke access and purge user
    if (routeKey === 'DELETE /user') {
      const athleteId = verifySession(headers);
      const athlete = await athleteRepository.getAthlete(athleteId, { decryptTokens: true });

      if (athlete && athlete.accessToken) {
        await stravaService.deauthorize(athlete.accessToken);
      }

      await athleteRepository.deleteAthlete(athleteId);
      logger.info({ athleteId }, 'Athlete disconnected and record removed');

      return buildResponse(200, {
        success: true,
        message: 'Athlete disconnected and data deleted successfully',
      });
    }

    // 7. GET /api/apps - List registered mini-apps and capabilities
    if (routeKey === 'GET /api/apps') {
      const apps = appRegistry.getRegisteredApps();
      return buildResponse(200, { apps });
    }

    // 404 Route Not Found
    return buildResponse(404, { error: `Route not found: ${routeKey}` });
  } catch (error) {
    return handleError(error, { routeKey });
  }
}

module.exports = {
  handler,
  verifySession,
  buildResponse,
  getJwtSecret,
};
