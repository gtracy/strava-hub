const { mockClient } = require('aws-sdk-client-mock');
const {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
} = require('@aws-sdk/lib-dynamodb');
const kmsService = require('../services/kms');
const athleteRepository = require('../repositories/athlete-repository');

const ddbMock = mockClient(DynamoDBDocumentClient);

describe('Athlete Repository', () => {
  let encryptSpy;
  let decryptSpy;

  beforeEach(() => {
    ddbMock.reset();
    encryptSpy = jest.spyOn(kmsService, 'encrypt');
    decryptSpy = jest.spyOn(kmsService, 'decrypt');
    process.env.ATHLETES_TABLE_NAME = 'strava-hub-dev-athletes';
  });

  afterEach(() => {
    encryptSpy.mockRestore();
    decryptSpy.mockRestore();
  });

  afterAll(() => {
    delete process.env.ATHLETES_TABLE_NAME;
  });

  describe('saveAthlete', () => {
    test('encrypts tokens and writes athlete record to DynamoDB', async () => {
      encryptSpy
        .mockResolvedValueOnce('enc-access-token')
        .mockResolvedValueOnce('enc-refresh-token');

      ddbMock.on(GetCommand).resolves({ Item: undefined }); // new athlete
      ddbMock.on(PutCommand).resolves({});

      const saved = await athleteRepository.saveAthlete({
        athleteId: '12345678',
        firstname: 'Greg',
        lastname: 'Tracy',
        profile: 'https://example.com/avatar.jpg',
        accessToken: 'raw-access-token',
        refreshToken: 'raw-refresh-token',
        expiresAt: 1725600000,
        city: 'Denver',
        state: 'CO',
        country: 'United States',
      });

      expect(saved.athleteId).toBe('12345678');
      expect(saved.firstname).toBe('Greg');
      expect(saved.encryptedAccessToken).toBe('enc-access-token');
      expect(saved.encryptedRefreshToken).toBe('enc-refresh-token');
      expect(saved.createdAt).toBeDefined();
      expect(saved.updatedAt).toBeDefined();

      expect(encryptSpy).toHaveBeenCalledWith('raw-access-token');
      expect(encryptSpy).toHaveBeenCalledWith('raw-refresh-token');
      expect(ddbMock.calls()).toHaveLength(2); // 1 get, 1 put
    });

    test('preserves existing tokens and timestamps when updating profile without new tokens', async () => {
      ddbMock.on(GetCommand).resolves({
        Item: {
          athleteId: '12345678',
          createdAt: '2026-01-01T00:00:00.000Z',
          encryptedAccessToken: 'existing-enc-access',
          encryptedRefreshToken: 'existing-enc-refresh',
          totalActivities: 42,
        },
      });
      ddbMock.on(PutCommand).resolves({});

      const saved = await athleteRepository.saveAthlete({
        athleteId: '12345678',
        firstname: 'Gregory',
      });

      expect(saved.athleteId).toBe('12345678');
      expect(saved.firstname).toBe('Gregory');
      expect(saved.createdAt).toBe('2026-01-01T00:00:00.000Z');
      expect(saved.encryptedAccessToken).toBe('existing-enc-access');
      expect(saved.totalActivities).toBe(42);
      expect(encryptSpy).not.toHaveBeenCalled();
    });
  });

  describe('getAthlete', () => {
    test('fetches and decrypts athlete tokens', async () => {
      ddbMock.on(GetCommand).resolves({
        Item: {
          athleteId: '12345678',
          firstname: 'Greg',
          encryptedAccessToken: 'enc-access',
          encryptedRefreshToken: 'enc-refresh',
        },
      });

      decryptSpy
        .mockResolvedValueOnce('decrypted-access')
        .mockResolvedValueOnce('decrypted-refresh');

      const athlete = await athleteRepository.getAthlete('12345678');
      expect(athlete).toBeDefined();
      expect(athlete.accessToken).toBe('decrypted-access');
      expect(athlete.refreshToken).toBe('decrypted-refresh');
      expect(decryptSpy).toHaveBeenCalledWith('enc-access');
      expect(decryptSpy).toHaveBeenCalledWith('enc-refresh');
    });

    test('returns null if athlete is not found', async () => {
      ddbMock.on(GetCommand).resolves({ Item: undefined });
      const athlete = await athleteRepository.getAthlete('999999');
      expect(athlete).toBeNull();
    });

    test('skips decryption when decryptTokens: false', async () => {
      ddbMock.on(GetCommand).resolves({
        Item: {
          athleteId: '12345678',
          encryptedAccessToken: 'enc-access',
        },
      });

      const athlete = await athleteRepository.getAthlete('12345678', { decryptTokens: false });
      expect(athlete.encryptedAccessToken).toBe('enc-access');
      expect(athlete.accessToken).toBeUndefined();
      expect(decryptSpy).not.toHaveBeenCalled();
    });
  });

  describe('updateSyncStatus', () => {
    test('updates lastSyncAt and totalActivities', async () => {
      const timestamp = new Date().toISOString();
      ddbMock.on(UpdateCommand).resolves({
        Attributes: {
          athleteId: '12345678',
          lastSyncAt: timestamp,
          totalActivities: 15,
        },
      });

      const result = await athleteRepository.updateSyncStatus('12345678', timestamp, 15);
      expect(result.lastSyncAt).toBe(timestamp);
      expect(result.totalActivities).toBe(15);
      expect(ddbMock.calls()).toHaveLength(1);
    });
  });

  describe('deleteAthlete', () => {
    test('deletes athlete from DynamoDB table', async () => {
      ddbMock.on(DeleteCommand).resolves({});
      const result = await athleteRepository.deleteAthlete('12345678');
      expect(result).toBe(true);
      expect(ddbMock.calls()).toHaveLength(1);
    });
  });
});
