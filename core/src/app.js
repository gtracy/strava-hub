const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const logger = require('./logger');
const athleteRepository = require('./repositories/athlete-repository');
const activityRepository = require('./repositories/activity-repository');
const stravaService = require('./services/strava');
const queueService = require('./services/queue');
const appRegistry = require('./services/app-registry');

/**
 * Retrieve and validate JWT secret.
 * Fails closed if secret is missing or shorter than 32 characters (CWE-798).
 */
function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('JWT_SECRET environment variable must be set and at least 32 characters long');
  }
  return secret;
}

/**
 * Constant-time comparison to protect against timing attacks (CWE-208).
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function timingSafeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Verify JWT session from Authorization header.
 * Pins algorithm to HS256 (CWE-327).
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
    const decoded = jwt.verify(token, getJwtSecret(), { algorithms: ['HS256'] });
    const athleteId = String(decoded.athleteId);
    if (!athleteRepository.isValidAthleteId(athleteId)) {
      const err = new Error('Invalid athlete ID format in session');
      err.statusCode = 401;
      throw err;
    }
    return athleteId;
  } catch (jwtErr) {
    const err = new Error(jwtErr.statusCode === 401 ? jwtErr.message : 'Invalid or expired session token');
    err.statusCode = 401;
    throw err;
  }
}

/**
 * Build hardened CORS and security response headers.
 */
function buildResponse(statusCode, body = {}) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
      'Cache-Control': 'no-store, max-age=0',
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

/**
 * Global error handler returning sanitized response.
 */
function handleError(error, context = {}) {
  const statusCode = error.statusCode || (error.message && error.message.includes('Unauthorized') ? 401 : 500);

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

      if (mode === 'subscribe' && verifyToken && expectedToken && timingSafeCompare(verifyToken, expectedToken)) {
        logger.info('Strava webhook subscription handshake verified');
        return {
          statusCode: 200,
          headers: {
            'Content-Type': 'application/json',
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'DENY',
            'Cache-Control': 'no-store, max-age=0',
          },
          body: JSON.stringify({ 'hub.challenge': challenge }),
        };
      }

      logger.warn(
        { mode, hasVerifyToken: !!verifyToken },
        'Strava webhook verification failed'
      );
      return buildResponse(403, { error: 'Forbidden' });
    }

    // 2. POST /webhook - Event Ingestion from Strava
    if (routeKey === 'POST /webhook') {
      // Timing-safe verification of webhook token if configured (CWE-306)
      const expectedToken = process.env.STRAVA_VERIFY_TOKEN;
      const params = new URLSearchParams(rawQuery);
      const postToken = queryStringParameters.token || queryStringParameters['hub.verify_token'] || params.get('token');

      if (expectedToken) {
        if (!postToken || !timingSafeCompare(postToken, expectedToken)) {
          logger.warn({ hasToken: !!postToken }, 'Unauthorized POST /webhook request');
          return buildResponse(403, { error: 'Forbidden' });
        }
      }

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
        const ownerIdStr = String(owner_id);
        if (updates?.authorized === 'false') {
          if (!athleteRepository.isValidAthleteId(ownerIdStr)) {
            logger.warn({ owner_id }, 'Invalid owner_id in athlete webhook event');
            return buildResponse(400, { error: 'Invalid athlete ID' });
          }
          const existingAthlete = await athleteRepository.getAthlete(ownerIdStr);
          if (existingAthlete) {
            logger.info({ owner_id: ownerIdStr }, 'Athlete deauthorized app from Strava');
            await athleteRepository.deleteAthlete(ownerIdStr);
          } else {
            logger.warn({ owner_id: ownerIdStr }, 'Deauthorization event for non-existent athlete');
          }
        }
        return buildResponse(200, { status: 'OK' });
      }

      // Handle activity events (create, update, delete)
      if (object_type === 'activity') {
        const ownerIdStr = String(owner_id);
        const objectIdStr = String(object_id);

        if (!athleteRepository.isValidAthleteId(ownerIdStr) || !activityRepository.isValidId(objectIdStr)) {
          logger.warn({ owner_id, object_id }, 'Invalid owner_id or object_id format in webhook event');
          return buildResponse(400, { error: 'Invalid identifier format' });
        }

        await queueService.enqueueActivitySync(ownerIdStr, objectIdStr, aspect_type, updates);
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
      if (!athleteRepository.isValidAthleteId(athleteIdStr)) {
        return buildResponse(502, { error: 'Invalid athlete ID returned by Strava' });
      }

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

      // Trigger automatic 60-day historical backfill with concurrency lock
      const initialJobId = crypto.randomUUID();
      try {
        const lockAcquired = await athleteRepository.acquireSyncLock(athleteIdStr, initialJobId, 60);
        if (lockAcquired) {
          await queueService.enqueueActivityFetch(athleteIdStr, 60, initialJobId);
        }
      } catch (queueErr) {
        logger.warn(
          { athleteId: athleteIdStr, errMessage: queueErr.message },
          'Failed to trigger initial backfill on sign-in'
        );
      }

      // Generate signed JWT session token (14-day expiry, pinned HS256)
      const sessionToken = jwt.sign(
        {
          athleteId: athleteIdStr,
          firstname: athleteData.firstname,
          lastname: athleteData.lastname,
        },
        getJwtSecret(),
        { algorithm: 'HS256', expiresIn: '14d' }
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
        tier: athlete.tier || 'free',
        syncJob: athlete.syncJob || null,
      });
    }

    // 5. POST /user/sync - Request manual backfill
    if (routeKey === 'POST /user/sync') {
      const athleteId = verifySession(headers);
      const body = typeof event.body === 'string' ? JSON.parse(event.body || '{}') : event.body;
      const days = Number(body?.days ?? 60);

      if (Number.isNaN(days) || days < 1) {
        return buildResponse(400, { error: 'Invalid days parameter: must be a positive number' });
      }

      if (days > 365) {
        return buildResponse(400, {
          error: 'For archives greater than 1 year, please use the Strava Bulk ZIP Import to avoid API rate limits.',
        });
      }

      const jobId = crypto.randomUUID();
      const lockAcquired = await athleteRepository.acquireSyncLock(athleteId, jobId, days);

      if (!lockAcquired) {
        return buildResponse(409, {
          error: 'Sync already in progress. Please wait for the current sync to complete.',
        });
      }

      await queueService.enqueueActivityFetch(athleteId, days, jobId);

      return buildResponse(202, {
        success: true,
        jobId,
        days,
        message: `Backfill job enqueued for the last ${days} days`,
      });
    }

    // 6. DELETE /user - Revoke access and purge user
    if (routeKey === 'DELETE /user') {
      const athleteId = verifySession(headers);
      const athlete = await athleteRepository.getAthlete(athleteId, { decryptTokens: true });

      if (athlete && athlete.accessToken) {
        try {
          await stravaService.deauthorize(athlete.accessToken);
        } catch (deauthErr) {
          logger.warn({ athleteId, errMessage: deauthErr.message }, 'Failed to deauthorize token with Strava during account deletion');
        }
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
  timingSafeCompare,
};
