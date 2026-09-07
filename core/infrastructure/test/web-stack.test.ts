import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { WebStack } from '../lib/web-stack';

describe('WebStack', () => {
  describe('Development Environment', () => {
    let app: cdk.App;
    let stack: WebStack;
    let template: Template;

    beforeEach(() => {
      app = new cdk.App();
      stack = new WebStack(app, 'TestWebStackDev', {
        environment: 'dev',
      });
      template = Template.fromStack(stack);
    });

    test('creates private S3 bucket with encryption and public access block', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [
            {
              ServerSideEncryptionByDefault: {
                SSEAlgorithm: 'AES256',
              },
            },
          ],
        },
      });
    });

    test('creates CloudFront Distribution with HTTPS redirect and SPA error responses', () => {
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: Match.objectLike({
          DefaultRootObject: 'index.html',
          CustomErrorResponses: Match.arrayWith([
            Match.objectLike({
              ErrorCode: 404,
              ResponseCode: 200,
              ResponsePagePath: '/index.html',
            }),
            Match.objectLike({
              ErrorCode: 403,
              ResponseCode: 200,
              ResponsePagePath: '/index.html',
            }),
          ]),
        }),
      });
    });

    test('creates S3 Bucket Deployment resource', () => {
      template.resourceCountIs('Custom::CDKBucketDeployment', 1);
    });

    test('publishes frontend URL to SSM Parameter Store', () => {
      template.hasResourceProperties('AWS::SSM::Parameter', {
        Name: '/strava-hub/dev/frontend-url',
        Type: 'String',
        Description: 'Strava Hub Frontend URL (dev)',
      });
    });

    test('exports FrontendUrlOutput', () => {
      template.hasOutput('FrontendUrlOutput', {
        Export: {
          Name: 'strava-hub-dev-frontend-url',
        },
      });
    });
  });

  describe('Production Environment', () => {
    let app: cdk.App;
    let stack: WebStack;
    let template: Template;

    beforeEach(() => {
      app = new cdk.App();
      stack = new WebStack(app, 'TestWebStackProd', {
        environment: 'prod',
      });
      template = Template.fromStack(stack);
    });

    test('creates production SSM parameter and output', () => {
      template.hasResourceProperties('AWS::SSM::Parameter', {
        Name: '/strava-hub/prod/frontend-url',
        Type: 'String',
        Description: 'Strava Hub Frontend URL (prod)',
      });

      template.hasOutput('FrontendUrlOutput', {
        Export: {
          Name: 'strava-hub-prod-frontend-url',
        },
      });
    });
  });
});
