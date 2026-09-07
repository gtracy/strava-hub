const { mockClient } = require('aws-sdk-client-mock');
const { SQSClient, SendMessageCommand, SendMessageBatchCommand } = require('@aws-sdk/client-sqs');
const queueService = require('../services/queue');

const sqsMock = mockClient(SQSClient);

describe('Queue Service', () => {
  beforeEach(() => {
    sqsMock.reset();
    process.env.SYNC_QUEUE_URL = 'https://sqs.us-east-2.amazonaws.com/123/sync-queue';
    process.env.FETCH_QUEUE_URL = 'https://sqs.us-east-2.amazonaws.com/123/fetch-queue';
  });

  afterAll(() => {
    delete process.env.SYNC_QUEUE_URL;
    delete process.env.FETCH_QUEUE_URL;
  });

  test('enqueueActivitySync sends message with correct payload', async () => {
    sqsMock.on(SendMessageCommand).resolves({ MessageId: 'msg-123' });

    const messageId = await queueService.enqueueActivitySync('12345', '98765', 'create', { title: 'Run' });
    expect(messageId).toBe('msg-123');

    const calls = sqsMock.commandCalls(SendMessageCommand);
    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0].args[0].input.MessageBody);
    expect(body.athleteId).toBe('12345');
    expect(body.activityId).toBe('98765');
    expect(body.aspectType).toBe('create');
  });

  test('enqueueActivitySyncBatch batches into chunks of 10', async () => {
    sqsMock.on(SendMessageBatchCommand).resolves({
      Successful: [{ MessageId: 'm1' }, { MessageId: 'm2' }],
    });

    const items = Array.from({ length: 15 }, (_, i) => ({
      activityId: `${100 + i}`,
      aspectType: 'create',
    }));

    const result = await queueService.enqueueActivitySyncBatch('12345', items);
    // 15 items with batchSize 10 results in 2 batch calls
    expect(sqsMock.commandCalls(SendMessageBatchCommand)).toHaveLength(2);
    expect(result).toHaveLength(4); // 2 per mocked batch
  });

  test('enqueueActivityFetch sends fetch request to fetch queue', async () => {
    sqsMock.on(SendMessageCommand).resolves({ MessageId: 'fetch-msg-1' });

    const messageId = await queueService.enqueueActivityFetch('12345', 60);
    expect(messageId).toBe('fetch-msg-1');

    const calls = sqsMock.commandCalls(SendMessageCommand);
    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0].args[0].input.MessageBody);
    expect(body.athleteId).toBe('12345');
    expect(body.days).toBe(60);
  });
});
