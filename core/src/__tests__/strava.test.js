const axios = require('axios');
const stravaService = require('../services/strava');

describe('Strava Service', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    process.env.STRAVA_CLIENT_ID = 'test-client-id';
    process.env.STRAVA_CLIENT_SECRET = 'test-client-secret';
  });

  afterAll(() => {
    delete process.env.STRAVA_CLIENT_ID;
    delete process.env.STRAVA_CLIENT_SECRET;
  });

  describe('exchangeCode', () => {
    test('exchanges code for tokens and athlete data', async () => {
      const mockResponse = {
        data: {
          access_token: 'test-access',
          refresh_token: 'test-refresh',
          expires_at: 1725600000,
          athlete: { id: 12345, firstname: 'Jane' },
        },
      };
      const postSpy = jest.spyOn(axios, 'post').mockResolvedValueOnce(mockResponse);

      const result = await stravaService.exchangeCode('auth-code-123');
      expect(result.access_token).toBe('test-access');
      expect(result.athlete.id).toBe(12345);
      expect(postSpy).toHaveBeenCalledWith(
        'https://www.strava.com/oauth/token',
        expect.objectContaining({
          code: 'auth-code-123',
          grant_type: 'authorization_code',
        })
      );
    });

    test('throws error if code is missing', async () => {
      await expect(stravaService.exchangeCode('')).rejects.toThrow(
        'Missing authorization code'
      );
    });
  });

  describe('refreshToken', () => {
    test('refreshes token successfully', async () => {
      const mockResponse = {
        data: {
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          expires_at: 1725650000,
        },
      };
      jest.spyOn(axios, 'post').mockResolvedValueOnce(mockResponse);

      const result = await stravaService.refreshToken('old-refresh');
      expect(result.access_token).toBe('new-access');
    });

    test('throws TokenRevokedError on 401', async () => {
      const err = new Error('Unauthorized');
      err.response = { status: 401, data: { message: 'Invalid Refresh Token' } };
      jest.spyOn(axios, 'post').mockRejectedValueOnce(err);

      await expect(stravaService.refreshToken('bad-refresh')).rejects.toThrow(
        stravaService.TokenRevokedError
      );
    });

    test('throws RateLimitError on 429', async () => {
      const err = new Error('Too Many Requests');
      err.response = { status: 429 };
      jest.spyOn(axios, 'post').mockRejectedValueOnce(err);

      await expect(stravaService.refreshToken('any-refresh')).rejects.toThrow(
        stravaService.RateLimitError
      );
    });
  });

  describe('getActivity', () => {
    test('fetches detailed activity by ID', async () => {
      const mockActivity = { id: 999, name: 'Trail Ride', distance: 15000 };
      const getSpy = jest.spyOn(axios, 'get').mockResolvedValueOnce({ data: mockActivity });

      const activity = await stravaService.getActivity('valid-token', 999);
      expect(activity.name).toBe('Trail Ride');
      expect(getSpy).toHaveBeenCalledWith(
        'https://www.strava.com/api/v3/activities/999',
        expect.objectContaining({
          headers: { Authorization: 'Bearer valid-token' },
        })
      );
    });

    test('throws TokenRevokedError on 401', async () => {
      const err = new Error('Unauthorized');
      err.response = { status: 401 };
      jest.spyOn(axios, 'get').mockRejectedValueOnce(err);

      await expect(stravaService.getActivity('expired-token', 999)).rejects.toThrow(
        stravaService.TokenRevokedError
      );
    });
  });

  describe('listActivities', () => {
    test('fetches activity page with epoch boundaries', async () => {
      const mockList = [{ id: 1 }, { id: 2 }];
      const getSpy = jest.spyOn(axios, 'get').mockResolvedValueOnce({ data: mockList });

      const list = await stravaService.listActivities('valid-token', 1700000000, 1700500000, 1, 30);
      expect(list).toHaveLength(2);
      expect(getSpy).toHaveBeenCalledWith(
        'https://www.strava.com/api/v3/athlete/activities',
        expect.objectContaining({
          params: { after: 1700000000, before: 1700500000, page: 1, per_page: 30 },
        })
      );
    });
  });

  describe('deauthorize', () => {
    test('calls deauthorize endpoint successfully', async () => {
      jest.spyOn(axios, 'post').mockResolvedValueOnce({});
      const result = await stravaService.deauthorize('access-token');
      expect(result).toBe(true);
    });

    test('handles error gracefully and returns false', async () => {
      jest.spyOn(axios, 'post').mockRejectedValueOnce(new Error('Network error'));
      const result = await stravaService.deauthorize('access-token');
      expect(result).toBe(false);
    });
  });
});
