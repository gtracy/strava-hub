import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { CoreDataStack } from '../lib/core-data-stack';

describe('CoreDataStack', () => {
  describe('Development Environment', () => {
    let app: cdk.App;
    let stack: CoreDataStack;
    let template: Template;

    beforeEach(() => {
      app = new cdk.App();
      stack = new CoreDataStack(app, 'TestCoreStackDev', {
        environment: 'dev',
      });
      template = Template.fromStack(stack);
    });

    test('creates KMS Key with key rotation and dev alias', () => {
      template.hasResourceProperties('AWS::KMS::Key', {
        EnableKeyRotation: true,
        Description: 'KMS key for encrypting Strava athlete tokens and sensitive data (dev)',
      });

      template.hasResourceProperties('AWS::KMS::Alias', {
        AliasName: 'alias/strava-hub-dev-key',
      });
    });

    test('creates Athletes DynamoDB table with correct keys and pay-per-request billing', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        TableName: 'strava-hub-dev-athletes',
        BillingMode: 'PAY_PER_REQUEST',
        KeySchema: [
          { AttributeName: 'athleteId', KeyType: 'HASH' },
        ],
        AttributeDefinitions: Match.arrayWith([
          { AttributeName: 'athleteId', AttributeType: 'S' },
        ]),
        SSESpecification: {
          SSEEnabled: true,
          SSEType: 'KMS',
        },
      });
    });

    test('creates Activities DynamoDB table with GSI for timeline queries', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        TableName: 'strava-hub-dev-activities',
        BillingMode: 'PAY_PER_REQUEST',
        KeySchema: [
          { AttributeName: 'athleteId', KeyType: 'HASH' },
          { AttributeName: 'activityId', KeyType: 'RANGE' },
        ],
        GlobalSecondaryIndexes: [
          {
            IndexName: 'AthleteStartDateIndex',
            KeySchema: [
              { AttributeName: 'athleteId', KeyType: 'HASH' },
              { AttributeName: 'startDate', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
          },
        ],
      });
    });

    test('creates Raw Data S3 bucket with strict security and KMS encryption', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
        VersioningConfiguration: {
          Status: 'Enabled',
        },
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [
            {
              ServerSideEncryptionByDefault: {
                SSEAlgorithm: 'aws:kms',
              },
            },
          ],
        },
      });

      // Enforce SSL Bucket Policy
      template.hasResourceProperties('AWS::S3::BucketPolicy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: 'Deny',
              Condition: {
                Bool: {
                  'aws:SecureTransport': 'false',
                },
              },
            }),
          ]),
        },
      });
    });

    test('creates Custom EventBridge Event Bus', () => {
      template.hasResourceProperties('AWS::Events::EventBus', {
        Name: 'strava-hub-dev-bus',
        Description: 'Custom EventBridge bus for Strava Hub platform activity events (dev)',
      });
    });

    test('publishes all 10 contract SSM parameters for mini-apps', () => {
      const expectedParams = [
        '/strava-hub/dev/event-bus-name',
        '/strava-hub/dev/event-bus-arn',
        '/strava-hub/dev/activities-table-name',
        '/strava-hub/dev/activities-table-arn',
        '/strava-hub/dev/athletes-table-name',
        '/strava-hub/dev/athletes-table-arn',
        '/strava-hub/dev/raw-bucket-name',
        '/strava-hub/dev/raw-bucket-arn',
        '/strava-hub/dev/kms-key-id',
        '/strava-hub/dev/kms-key-arn',
      ];

      for (const paramName of expectedParams) {
        template.hasResourceProperties('AWS::SSM::Parameter', {
          Name: paramName,
        });
      }
    });
  });

  describe('Production Environment', () => {
    let app: cdk.App;
    let stack: CoreDataStack;
    let template: Template;

    beforeEach(() => {
      app = new cdk.App();
      stack = new CoreDataStack(app, 'TestCoreStackProd', {
        environment: 'prod',
      });
      template = Template.fromStack(stack);
    });

    test('enables Point-in-Time Recovery on DynamoDB tables in prod', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        TableName: 'strava-hub-prod-athletes',
        PointInTimeRecoverySpecification: {
          PointInTimeRecoveryEnabled: true,
        },
      });

      template.hasResourceProperties('AWS::DynamoDB::Table', {
        TableName: 'strava-hub-prod-activities',
        PointInTimeRecoverySpecification: {
          PointInTimeRecoveryEnabled: true,
        },
      });
    });

    test('creates prod EventBridge Bus and SSM parameters with prod prefix', () => {
      template.hasResourceProperties('AWS::Events::EventBus', {
        Name: 'strava-hub-prod-bus',
      });

      template.hasResourceProperties('AWS::SSM::Parameter', {
        Name: '/strava-hub/prod/event-bus-name',
      });
    });
  });
});
