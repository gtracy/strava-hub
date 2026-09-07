const { KMSClient, EncryptCommand, DecryptCommand } = require('@aws-sdk/client-kms');
const logger = require('../logger');

const region = process.env.AWS_REGION || 'us-east-2';
const kmsClient = new KMSClient({ region });

/**
 * Encrypt a plaintext string using AWS KMS.
 * @param {string} plaintext - Plaintext to encrypt
 * @param {string} keyId - KMS Key ID or Alias ARN
 * @returns {Promise<string>} Base64-encoded ciphertext
 */
async function encrypt(plaintext, keyId = process.env.KMS_KEY_ID) {
  if (!plaintext) {
    return null;
  }
  if (!keyId) {
    throw new Error('KMS_KEY_ID environment variable is not configured');
  }

  try {
    const command = new EncryptCommand({
      KeyId: keyId,
      Plaintext: Buffer.from(plaintext, 'utf8'),
    });
    const response = await kmsClient.send(command);
    return Buffer.from(response.CiphertextBlob).toString('base64');
  } catch (error) {
    logger.error(
      { keyId, errMessage: error.message, errCode: error.name },
      'KMS encryption failed'
    );
    throw error;
  }
}

/**
 * Decrypt a base64-encoded ciphertext using AWS KMS.
 * @param {string} ciphertextBase64 - Base64 ciphertext
 * @param {string} keyId - Optional KMS Key ID
 * @returns {Promise<string>} UTF-8 plaintext
 */
async function decrypt(ciphertextBase64, keyId = process.env.KMS_KEY_ID) {
  if (!ciphertextBase64) {
    return null;
  }

  try {
    const command = new DecryptCommand({
      CiphertextBlob: Buffer.from(ciphertextBase64, 'base64'),
      KeyId: keyId,
    });
    const response = await kmsClient.send(command);
    return Buffer.from(response.Plaintext).toString('utf8');
  } catch (error) {
    logger.error(
      { keyId, errMessage: error.message, errCode: error.name },
      'KMS decryption failed'
    );
    throw error;
  }
}

module.exports = {
  encrypt,
  decrypt,
  kmsClient,
};
