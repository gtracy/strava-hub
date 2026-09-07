const { mockClient } = require('aws-sdk-client-mock');
const { KMSClient, EncryptCommand, DecryptCommand } = require('@aws-sdk/client-kms');
const kmsService = require('../services/kms');

const kmsMock = mockClient(KMSClient);

describe('KMS Service', () => {
  beforeEach(() => {
    kmsMock.reset();
    process.env.KMS_KEY_ID = 'test-key-id';
  });

  afterAll(() => {
    delete process.env.KMS_KEY_ID;
  });

  test('encrypt returns base64 ciphertext on success', async () => {
    const fakeCiphertext = Buffer.from('encrypted-data');
    kmsMock.on(EncryptCommand).resolves({
      CiphertextBlob: fakeCiphertext,
    });

    const result = await kmsService.encrypt('secret-strava-token', 'test-key-id');
    expect(result).toBe(fakeCiphertext.toString('base64'));
    expect(kmsMock.calls()).toHaveLength(1);
  });

  test('encrypt returns null if input plaintext is empty', async () => {
    const result = await kmsService.encrypt('');
    expect(result).toBeNull();
    expect(kmsMock.calls()).toHaveLength(0);
  });

  test('encrypt throws if KMS_KEY_ID is missing', async () => {
    delete process.env.KMS_KEY_ID;
    await expect(kmsService.encrypt('secret', null)).rejects.toThrow(
      'KMS_KEY_ID environment variable is not configured'
    );
  });

  test('decrypt returns UTF-8 plaintext on success', async () => {
    const plaintext = 'decrypted-strava-token';
    kmsMock.on(DecryptCommand).resolves({
      Plaintext: Buffer.from(plaintext, 'utf8'),
    });

    const base64Input = Buffer.from('ciphertext').toString('base64');
    const result = await kmsService.decrypt(base64Input, 'test-key-id');
    expect(result).toBe(plaintext);
    expect(kmsMock.calls()).toHaveLength(1);
  });

  test('decrypt returns null if input ciphertext is empty', async () => {
    const result = await kmsService.decrypt('');
    expect(result).toBeNull();
    expect(kmsMock.calls()).toHaveLength(0);
  });

  test('handles remote KMS error and logs properly', async () => {
    kmsMock.on(EncryptCommand).rejects(new Error('KMS service unreachable'));
    await expect(kmsService.encrypt('secret')).rejects.toThrow('KMS service unreachable');
  });
});
