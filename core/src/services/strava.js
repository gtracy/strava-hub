const axios = require('axios');
const logger = require('../logger');

class RateLimitError extends Error {
  constructor(message, retryAfterSeconds = 900) {
    super(message);
    this.name = 'RateLimitError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

class TokenRevokedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TokenRevokedError';
  }
}

const STRAVA_API_BASE = 'https://www.strava.com/api/v3';
const STRAVA_OAUTH_BASE = 'https://www.strava.com/oauth';

/**
 * Exchange an authorization code for Strava access and refresh tokens.
 * @param {string} code - OAuth authorization code
 * @param {string} [clientId] - Optional client ID (defaults to env)
 * @param {string} [clientSecret] - Optional client secret (defaults to env)
 */
async function exchangeCode(
  code,
  clientId = process.env.STRAVA_CLIENT_ID,
  clientSecret = process.env.STRAVA_CLIENT_SECRET
) {
  if (!code) {
    throw new Error('Missing authorization code for Strava token exchange');
  }
  if (!clientId || !clientSecret) {
    throw new Error('Strava client credentials not configured');
  }

  try {
    const response = await axios.post(`${STRAVA_OAUTH_BASE}/token`, {
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
    });

    logger.info(
      { athleteId: response.data.athlete?.id },
      'Successfully exchanged Strava authorization code'
    );
    return response.data;
  } catch (error) {
    const status = error.response?.status;
    const errorData = error.response?.data;
    logger.error(
      { status, errorData, errMessage: error.message },
      'Failed to exchange Strava authorization code'
    );
    throw error;
  }
}

/**
 * Refresh an expired Strava access token using a refresh token.
 * @param {string} refreshToken
 * @param {string} [clientId]
 * @param {string} [clientSecret]
 */
async function refreshToken(
  refreshToken,
  clientId = process.env.STRAVA_CLIENT_ID,
  clientSecret = process.env.STRAVA_CLIENT_SECRET
) {
  if (!refreshToken) {
    throw new Error('Missing refresh token');
  }

  try {
    const response = await axios.post(`${STRAVA_OAUTH_BASE}/token`, {
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });

    logger.debug('Successfully refreshed Strava access token');
    return response.data;
  } catch (error) {
    const status = error.response?.status;
    if (status === 401 || status === 400) {
      logger.warn(
        { status, errData: error.response?.data },
        'Strava refresh token rejected or revoked'
      );
      throw new TokenRevokedError('Strava refresh token revoked or invalid');
    }
    if (status === 429) {
      logger.warn({ status }, 'Strava rate limit hit during token refresh');
      throw new RateLimitError('Strava rate limit exceeded');
    }

    logger.error(
      { status, errMessage: error.message },
      'Failed to refresh Strava token'
    );
    throw error;
  }
}

/**
 * Fetch detailed activity payload by activity ID.
 * @param {string} accessToken
 * @param {string|number} activityId
 * @param {boolean} [includeAllEfforts=true]
 */
async function getActivity(accessToken, activityId, includeAllEfforts = true) {
  if (!accessToken) {
    throw new Error('Missing access token');
  }
  if (!activityId) {
    throw new Error('Missing activity ID');
  }

  try {
    const response = await axios.get(
      `${STRAVA_API_BASE}/activities/${activityId}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        params: {
          include_all_efforts: includeAllEfforts,
        },
      }
    );

    logger.debug({ activityId }, 'Fetched detailed activity from Strava');
    return response.data;
  } catch (error) {
    const status = error.response?.status;
    if (status === 401) {
      throw new TokenRevokedError('Access token expired or unauthorized');
    }
    if (status === 429) {
      throw new RateLimitError('Strava rate limit exceeded');
    }

    logger.error(
      { activityId, status, errMessage: error.message },
      'Failed to fetch activity from Strava'
    );
    throw error;
  }
}

/**
 * List athlete activities between timestamps.
 * @param {string} accessToken
 * @param {number} afterEpoch - Unix epoch seconds
 * @param {number} beforeEpoch - Unix epoch seconds
 * @param {number} [page=1]
 * @param {number} [perPage=200]
 */
async function listActivities(accessToken, afterEpoch, beforeEpoch, page = 1, perPage = 200) {
  if (!accessToken) {
    throw new Error('Missing access token');
  }

  try {
    const params = {
      page,
      per_page: perPage,
    };
    if (afterEpoch) params.after = afterEpoch;
    if (beforeEpoch) params.before = beforeEpoch;

    const response = await axios.get(`${STRAVA_API_BASE}/athlete/activities`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      params,
    });

    logger.debug(
      { page, count: response.data.length },
      'Fetched activity page from Strava'
    );
    return response.data;
  } catch (error) {
    const status = error.response?.status;
    if (status === 401) {
      throw new TokenRevokedError('Access token unauthorized');
    }
    if (status === 429) {
      throw new RateLimitError('Strava rate limit exceeded');
    }

    logger.error(
      { status, errMessage: error.message },
      'Failed to list activities from Strava'
    );
    throw error;
  }
}

/**
 * Deauthorize app access for an athlete.
 * @param {string} accessToken
 */
async function deauthorize(accessToken) {
  if (!accessToken) {
    return true;
  }

  try {
    await axios.post(`${STRAVA_OAUTH_BASE}/deauthorize`, null, {
      params: { access_token: accessToken },
    });
    logger.info('Successfully deauthorized Strava access');
    return true;
  } catch (error) {
    logger.warn(
      { errMessage: error.message },
      'Error during Strava deauthorization (may already be revoked)'
    );
    return false;
  }
}

module.exports = {
  exchangeCode,
  refreshToken,
  getActivity,
  listActivities,
  deauthorize,
  RateLimitError,
  TokenRevokedError,
};
