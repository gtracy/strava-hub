import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as path from 'path';

export interface HelloWorldStackProps extends cdk.StackProps {
  environment: 'dev' | 'prod';
}

export class HelloWorldStack extends cdk.Stack {
  public readonly appQueue: sqs.Queue;
  public readonly consumerLambda: NodejsFunction;

  constructor(scope: Construct, id: string, props: HelloWorldStackProps) {
    super(scope, id, props);

    const env = props.environment;
    const isProd = env === 'prod';
    const removalPolicy = isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY;

    cdk.Tags.of(this).add('Project', 'strava-hub-hello-world');
    cdk.Tags.of(this).add('Environment', env);
    cdk.Tags.of(this).add('ManagedBy', 'CDK');

    // 1. Contract-based discovery of Core Platform resources via SSM Parameter Store
    const eventBusArn = ssm.StringParameter.valueForStringParameter(
      this,
      `/strava-hub/${env}/event-bus-arn`
    );
    const activitiesTableName = ssm.StringParameter.valueForStringParameter(
      this,
      `/strava-hub/${env}/activities-table-name`
    );
    const rawBucketName = ssm.StringParameter.valueForStringParameter(
      this,
      `/strava-hub/${env}/raw-bucket-name`
    );

    // Import shared resources by contract
    const eventBus = events.EventBus.fromEventBusArn(this, 'ImportedEventBus', eventBusArn);

    const activitiesTable = dynamodb.Table.fromTableName(
      this,
      'ImportedActivitiesTable',
      activitiesTableName
    );

    const rawBucket = s3.Bucket.fromBucketName(
      this,
      'ImportedRawBucket',
      rawBucketName
    );

    // 2. Dead Letter Queue & Main SQS Queue for App
    const appDLQ = new sqs.Queue(this, 'AppDLQ', {
      queueName: `hello-world-${env}-dlq`,
      retentionPeriod: cdk.Duration.days(14),
      removalPolicy,
    });

    this.appQueue = new sqs.Queue(this, 'AppQueue', {
      queueName: `hello-world-${env}-queue`,
      visibilityTimeout: cdk.Duration.seconds(60),
      deadLetterQueue: {
        maxReceiveCount: 3,
        queue: appDLQ,
      },
      removalPolicy,
    });

    // 3. EventBridge Rule: Filter for new and updated activities
    const activityRule = new events.Rule(this, 'ActivitySubscriptionRule', {
      eventBus,
      ruleName: `hello-world-${env}-activity-rule`,
      description: 'Routes Strava Hub activity events to Hello World app queue',
      eventPattern: {
        source: ['strava.hub.activity'],
        detailType: ['ActivityCreated', 'ActivityUpdated'],
        detail: {
          isBackfill: [{ exists: false }],
        },
      },
    });

    activityRule.addTarget(new targets.SqsQueue(this.appQueue));

    // 4. Consumer Lambda Function
    const logGroup = new logs.LogGroup(this, 'ConsumerLogGroup', {
      logGroupName: `/aws/lambda/hello-world-${env}-consumer`,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy,
    });

    this.consumerLambda = new NodejsFunction(this, 'ConsumerLambda', {
      functionName: `hello-world-${env}-consumer`,
      description: `Hello World reference mini-app consumer (${env})`,
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(__dirname, '../../src/handler.js'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      logGroup,
      environment: {
        STAGE: env,
        LOG_LEVEL: isProd ? 'info' : 'debug',
        ACTIVITIES_TABLE_NAME: activitiesTableName,
        RAW_BUCKET_NAME: rawBucketName,
      },
      bundling: {
        minify: isProd,
        sourceMap: true,
      },
    });

    // Grant consumer permissions: read from shared data layer & receive from app queue
    activitiesTable.grantReadData(this.consumerLambda);
    rawBucket.grantRead(this.consumerLambda);

    this.consumerLambda.addEventSource(
      new SqsEventSource(this.appQueue, {
        batchSize: 5,
        maxBatchingWindow: cdk.Duration.seconds(5),
      })
    );

    // 5. Outputs
    new cdk.CfnOutput(this, 'AppQueueUrlOutput', {
      value: this.appQueue.queueUrl,
      description: `Hello World SQS Queue URL (${env})`,
      exportName: `hello-world-${env}-queue-url`,
    });

    new cdk.CfnOutput(this, 'ConsumerLambdaArnOutput', {
      value: this.consumerLambda.functionArn,
      description: `Hello World Consumer Lambda ARN (${env})`,
      exportName: `hello-world-${env}-consumer-arn`,
    });
  }
}
