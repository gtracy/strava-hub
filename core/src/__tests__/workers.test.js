const athleteRepository = require('../repositories/athlete-repository');
const activityRepository = require('../repositories/activity-repository');
const stravaService = require('../services/strava');
const eventbridgeService = require('../services/eventbridge');
const queueService = require('../services/queue');
const syncWorker = require('../workers/sync-worker');
const fetchWorker = require('../workers/fetch-worker');

describe('Workers', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  describe('SyncWorker', () => {
    test('processes create record: fetches detailed activity, saves, and emits event', async () => {
      jest.spyOn(athleteRepository, 'getAthlete').mockResolvedValueOnce({
        athleteId: '12345',
        accessToken: 'valid-token',
        refreshToken: 'refresh-token',
        expiresAt: Math.floor(Date.now() / 1000) + 3600, // 1 hour remaining
      });

      jest.spyOn(stravaService, 'getActivity').mockResolvedValueOnce({
        id: 999,
        name: 'Morning Run',
        type: 'Run',
        distance: 5000,
      });

      jest.spyOn(activityRepository, 'saveActivity').mockResolvedValueOnce({
        athleteId: '12345',
        activityId: '999',
        name: 'Morning Run',
      });

      jest.spyOn(athleteRepository, 'updateSyncStatus').mockResolvedValueOnce({});
      const publishSpy = jest.spyOn(eventbridgeService, 'publishActivityEvent').mockResolvedValueOnce('evt-1');

      const event = {
        Records: [
          {
            body: JSON.stringify({
              athleteId: '12345',
              activityId: '999',
              aspectType: 'create',
            }),
          },
        ],
      };

      await syncWorker.handler(event);

      expect(athleteRepository.getAthlete).toHaveBeenCalledWith('12345', { decryptTokens: true });
      expect(stravaService.getActivity).toHaveBeenCalledWith('valid-token', '999');
      expect(activityRepository.saveActivity).toHaveBeenCalled();
      expect(publishSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          athleteId: '12345',
          activityId: '999',
          aspectType: 'create',
        })
      );
    });

    test('processes delete record: removes from DDB and S3 and emits delete event', async () => {
      jest.spyOn(athleteRepository, 'getAthlete').mockResolvedValueOnce({
        athleteId: '12345',
      });
      const deleteSpy = jest.spyOn(activityRepository, 'deleteActivity').mockResolvedValueOnce(true);
      const publishSpy = jest.spyOn(eventbridgeService, 'publishActivityEvent').mockResolvedValueOnce('evt-del');

      const event = {
        Records: [
          {
            body: JSON.stringify({
              athleteId: '12345',
              activityId: '999',
              aspectType: 'delete',
            }),
          },
        ],
      };

      await syncWorker.handler(event);

      expect(deleteSpy).toHaveBeenCalledWith('12345', '999');
      expect(publishSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          aspectType: 'delete',
        })
      );
    });

    test('re-throws RateLimitError to trigger SQS retry backoff', async () => {
      jest.spyOn(athleteRepository, 'getAthlete').mockResolvedValueOnce({
        athleteId: '12345',
        accessToken: 'token',
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      });

      jest.spyOn(stravaService, 'getActivity').mockRejectedValueOnce(new stravaService.RateLimitError('Rate limit'));

      const event = {
        Records: [
          {
            body: JSON.stringify({
              athleteId: '12345',
              activityId: '999',
              aspectType: 'create',
            }),
          },
        ],
      };

      await expect(syncWorker.handler(event)).rejects.toThrow('Rate limit');
    });
  });

  describe('FetchWorker', () => {
    test('pages historical activities, saves summaries directly, emits backfill events, and completes sync job', async () => {
      jest.spyOn(athleteRepository, 'getAthlete').mockResolvedValueOnce({
        athleteId: '12345',
        accessToken: 'token',
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      });

      // Page 1 returns 2 activities (< 200 perPage, so terminates)
      jest.spyOn(stravaService, 'listActivities').mockResolvedValueOnce([
        { id: 101, name: 'Morning Run', distance: 5000, type: 'Run' },
        { id: 102, name: 'Evening Ride', distance: 20000, type: 'Ride' },
      ]);

      const saveSummarySpy = jest.spyOn(activityRepository, 'saveSummaryActivity').mockImplementation(async (athId, act) => ({
        athleteId: athId,
        activityId: String(act.id),
        name: act.name,
      }));

      const publishSpy = jest.spyOn(eventbridgeService, 'publishActivityEvent').mockResolvedValue('evt-backfill');
      const updateSyncSpy = jest.spyOn(athleteRepository, 'updateSyncStatus').mockResolvedValueOnce({});
      const completeSyncJobSpy = jest.spyOn(athleteRepository, 'completeSyncJob').mockResolvedValueOnce({});

      const event = {
        Records: [
          {
            body: JSON.stringify({
              athleteId: '12345',
              days: 60,
              jobId: 'job-abc-123',
            }),
          },
        ],
      };

      await fetchWorker.handler(event);

      expect(stravaService.listActivities).toHaveBeenCalledTimes(1);
      expect(saveSummarySpy).toHaveBeenCalledTimes(2);
      expect(publishSpy).toHaveBeenCalledTimes(2);
      expect(publishSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          athleteId: '12345',
          activityId: '101',
          isBackfill: true,
        })
      );
      expect(updateSyncSpy).toHaveBeenCalledWith('12345', expect.any(String), 2);
      expect(completeSyncJobSpy).toHaveBeenCalledWith('12345', 'job-abc-123', 'completed', 2);
    });

    test('marks sync job failed and re-throws RateLimitError on 429', async () => {
      jest.spyOn(athleteRepository, 'getAthlete').mockResolvedValueOnce({
        athleteId: '12345',
        accessToken: 'token',
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      });

      jest.spyOn(stravaService, 'listActivities').mockRejectedValueOnce(
        new stravaService.RateLimitError('Rate limit exceeded')
      );
      const completeSyncJobSpy = jest.spyOn(athleteRepository, 'completeSyncJob').mockResolvedValueOnce({});

      const event = {
        Records: [
          {
            body: JSON.stringify({
              athleteId: '12345',
              days: 30,
              jobId: 'job-fail-429',
            }),
          },
        ],
      };

      await expect(fetchWorker.handler(event)).rejects.toThrow('Rate limit exceeded');
      expect(completeSyncJobSpy).toHaveBeenCalledWith('12345', 'job-fail-429', 'failed', 0);
    });
  });
});
