import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { HelloWorldStack } from '../infrastructure/lib/hello-world-stack';

describe('HelloWorldStack', () => {
  let app: cdk.App;
  let stack: HelloWorldStack;
  let template: Template;

  beforeEach(() => {
    app = new cdk.App();
    stack = new HelloWorldStack(app, 'TestHelloWorldStackDev', {
      environment: 'dev',
    });
    template = Template.fromStack(stack);
  });

  test('creates app SQS queue and DLQ', () => {
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'hello-world-dev-dlq',
      MessageRetentionPeriod: 1209600, // 14 days
    });

    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'hello-world-dev-queue',
      VisibilityTimeout: 60,
      RedrivePolicy: Match.objectLike({
        maxReceiveCount: 3,
      }),
    });
  });

  test('creates EventBridge Rule filtering on Strava Hub activity events', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      Name: 'hello-world-dev-activity-rule',
      EventPattern: {
        source: ['strava.hub.activity'],
        'detail-type': ['ActivityCreated', 'ActivityUpdated'],
      },
    });
  });

  test('targets app SQS queue from EventBridge Rule', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      Targets: Match.arrayWith([
        Match.objectLike({
          Arn: {
            'Fn::GetAtt': [Match.stringLikeRegexp('AppQueue.*'), 'Arn'],
          },
        }),
      ]),
    });
  });

  test('creates consumer Lambda function and attaches SqsEventSource', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'hello-world-dev-consumer',
      Runtime: 'nodejs22.x',
      Timeout: 30,
      MemorySize: 256,
    });

    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      BatchSize: 5,
    });
  });

  test('exports stack outputs for queue URL and consumer ARN', () => {
    template.hasOutput('AppQueueUrlOutput', {
      Export: {
        Name: 'hello-world-dev-queue-url',
      },
    });

    template.hasOutput('ConsumerLambdaArnOutput', {
      Export: {
        Name: 'hello-world-dev-consumer-arn',
      },
    });
  });
});
