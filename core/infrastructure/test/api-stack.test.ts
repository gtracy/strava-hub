import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { CoreDataStack } from '../lib/core-data-stack';
import { ApiStack } from '../lib/api-stack';

describe('ApiStack', () => {
  let app: cdk.App;
  let dataStack: CoreDataStack;
  let apiStack: ApiStack;
  let template: Template;

  beforeEach(() => {
    app = new cdk.App();
    dataStack = new CoreDataStack(app, 'TestDataStackDev', {
      environment: 'dev',
    });
    apiStack = new ApiStack(app, 'TestApiStackDev', {
      environment: 'dev',
      kmsKey: dataStack.kmsKey,
      athletesTable: dataStack.athletesTable,
      activitiesTable: dataStack.activitiesTable,
      rawBucket: dataStack.rawBucket,
      eventBus: dataStack.eventBus,
    });
    template = Template.fromStack(apiStack);
  });

  test('creates ActivitySyncQueue and ActivityFetchQueue with DLQs', () => {
    // DLQs
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'strava-hub-dev-activity-sync-dlq',
      MessageRetentionPeriod: 1209600, // 14 days
    });
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'strava-hub-dev-activity-fetch-dlq',
      MessageRetentionPeriod: 1209600,
    });

    // Main Queues
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'strava-hub-dev-activity-sync-queue',
      VisibilityTimeout: 60,
      RedrivePolicy: Match.objectLike({
        maxReceiveCount: 3,
      }),
    });

    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'strava-hub-dev-activity-fetch-queue',
      VisibilityTimeout: 300,
      RedrivePolicy: Match.objectLike({
        maxReceiveCount: 3,
      }),
    });
  });

  test('creates CloudWatch alarms on both DLQs', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'strava-hub-dev-ActivitySync-DLQ-Alarm',
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      Threshold: 1,
    });

    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'strava-hub-dev-ActivityFetch-DLQ-Alarm',
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      Threshold: 1,
    });
  });

  test('creates Lambda functions for API handler, sync worker, and fetch worker', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'strava-hub-dev-api-handler',
      Runtime: 'nodejs22.x',
      Timeout: 30,
      MemorySize: 512,
    });

    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'strava-hub-dev-sync-worker',
      Runtime: 'nodejs22.x',
      Timeout: 60,
      MemorySize: 512,
    });

    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'strava-hub-dev-fetch-worker',
      Runtime: 'nodejs22.x',
      Timeout: 300,
      MemorySize: 512,
    });
  });

  test('creates SQS Event Source mappings for workers', () => {
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      BatchSize: 5,
      MaximumBatchingWindowInSeconds: 5,
    });

    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      BatchSize: 1,
    });
  });

  test('creates HTTP API Gateway with expected routes and CORS', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      Name: 'strava-hub-dev-api',
      ProtocolType: 'HTTP',
      CorsConfiguration: {
        AllowMethods: Match.arrayWith(['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS']),
        AllowOrigins: Match.arrayWith(['*']),
      },
    });

    const expectedRoutes = [
      'GET /webhook',
      'POST /webhook',
      'POST /auth/strava',
      'GET /user/status',
      'POST /user/sync',
      'DELETE /user',
      'GET /api/apps',
    ];

    for (const routeKey of expectedRoutes) {
      template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
        RouteKey: routeKey,
      });
    }
  });

  test('publishes SSM parameters for API endpoint and queue URLs', () => {
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/strava-hub/dev/api-endpoint',
    });

    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/strava-hub/dev/sync-queue-url',
    });

    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/strava-hub/dev/fetch-queue-url',
    });
  });
});
