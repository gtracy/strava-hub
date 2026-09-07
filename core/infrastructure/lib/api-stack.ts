import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as events from 'aws-cdk-lib/aws-events';
import * as path from 'path';

export interface ApiStackProps extends cdk.StackProps {
  environment: 'dev' | 'prod';
  kmsKey: kms.IKey;
  athletesTable: dynamodb.ITable;
  activitiesTable: dynamodb.ITable;
  rawBucket: s3.IBucket;
  eventBus: events.IEventBus;
}

export class ApiStack extends cdk.Stack {
  public readonly httpApi: apigwv2.HttpApi;
  public readonly activitySyncQueue: sqs.Queue;
  public readonly activityFetchQueue: sqs.Queue;
  public readonly apiLambda: NodejsFunction;
  public readonly syncWorker: NodejsFunction;
  public readonly fetchWorker: NodejsFunction;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const env = props.environment;
    const isProd = env === 'prod';
    const removalPolicy = isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY;

    cdk.Tags.of(this).add('Project', 'strava-hub');
    cdk.Tags.of(this).add('Environment', env);
    cdk.Tags.of(this).add('ManagedBy', 'CDK');

    // 1. Dead Letter Queues & Alarms
    const activitySyncDLQ = new sqs.Queue(this, 'ActivitySyncDLQ', {
      queueName: `strava-hub-${env}-activity-sync-dlq`,
      retentionPeriod: cdk.Duration.days(14),
      removalPolicy,
    });

    const activityFetchDLQ = new sqs.Queue(this, 'ActivityFetchDLQ', {
      queueName: `strava-hub-${env}-activity-fetch-dlq`,
      retentionPeriod: cdk.Duration.days(14),
      removalPolicy,
    });

    new cloudwatch.Alarm(this, 'ActivitySyncDLQAlarm', {
      alarmName: `strava-hub-${env}-ActivitySync-DLQ-Alarm`,
      metric: activitySyncDLQ.metricApproximateNumberOfMessagesVisible(),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    });

    new cloudwatch.Alarm(this, 'ActivityFetchDLQAlarm', {
      alarmName: `strava-hub-${env}-ActivityFetch-DLQ-Alarm`,
      metric: activityFetchDLQ.metricApproximateNumberOfMessagesVisible(),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    });

    // 2. Main SQS Queues
    this.activitySyncQueue = new sqs.Queue(this, 'ActivitySyncQueue', {
      queueName: `strava-hub-${env}-activity-sync-queue`,
      visibilityTimeout: cdk.Duration.seconds(60),
      deadLetterQueue: {
        maxReceiveCount: 3,
        queue: activitySyncDLQ,
      },
      removalPolicy,
    });

    this.activityFetchQueue = new sqs.Queue(this, 'ActivityFetchQueue', {
      queueName: `strava-hub-${env}-activity-fetch-queue`,
      visibilityTimeout: cdk.Duration.seconds(300),
      deadLetterQueue: {
        maxReceiveCount: 3,
        queue: activityFetchDLQ,
      },
      removalPolicy,
    });

    // Shared Lambda environment variables
    const commonLambdaEnv: Record<string, string> = {
      STAGE: env,
      LOG_LEVEL: isProd ? 'info' : 'debug',
      ATHLETES_TABLE_NAME: props.athletesTable.tableName,
      ACTIVITIES_TABLE_NAME: props.activitiesTable.tableName,
      RAW_BUCKET_NAME: props.rawBucket.bucketName,
      SYNC_QUEUE_URL: this.activitySyncQueue.queueUrl,
      FETCH_QUEUE_URL: this.activityFetchQueue.queueUrl,
      EVENT_BUS_NAME: props.eventBus.eventBusName,
      KMS_KEY_ID: props.kmsKey.keyId,
      STRAVA_CLIENT_ID: process.env.STRAVA_CLIENT_ID || '',
      STRAVA_CLIENT_SECRET: process.env.STRAVA_CLIENT_SECRET || '',
      STRAVA_VERIFY_TOKEN: process.env.STRAVA_VERIFY_TOKEN || '',
      JWT_SECRET: process.env.JWT_SECRET || '',
    };

    // 3. API Handler Lambda
    const apiLogGroup = new logs.LogGroup(this, 'ApiHandlerLogGroup', {
      logGroupName: `/aws/lambda/strava-hub-${env}-api-handler`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy,
    });

    this.apiLambda = new NodejsFunction(this, 'ApiHandlerLambda', {
      functionName: `strava-hub-${env}-api-handler`,
      description: `Strava Hub API Handler for auth, webhooks, and status (${env})`,
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(__dirname, '../../src/app.js'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      logGroup: apiLogGroup,
      environment: commonLambdaEnv,
      bundling: {
        minify: isProd,
        sourceMap: true,
      },
    });

    props.kmsKey.grantEncryptDecrypt(this.apiLambda);
    props.athletesTable.grantReadWriteData(this.apiLambda);
    props.activitiesTable.grantReadData(this.apiLambda);
    this.activitySyncQueue.grantSendMessages(this.apiLambda);
    this.activityFetchQueue.grantSendMessages(this.apiLambda);

    // 4. Sync Worker Lambda (SQS EventSource)
    const syncLogGroup = new logs.LogGroup(this, 'SyncWorkerLogGroup', {
      logGroupName: `/aws/lambda/strava-hub-${env}-sync-worker`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy,
    });

    this.syncWorker = new NodejsFunction(this, 'SyncWorkerLambda', {
      functionName: `strava-hub-${env}-sync-worker`,
      description: `Strava Hub Sync Worker processing detailed activity records (${env})`,
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(__dirname, '../../src/workers/sync-worker.js'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(60),
      memorySize: 512,
      logGroup: syncLogGroup,
      environment: commonLambdaEnv,
      bundling: {
        minify: isProd,
        sourceMap: true,
      },
    });

    props.kmsKey.grantEncryptDecrypt(this.syncWorker);
    props.athletesTable.grantReadWriteData(this.syncWorker);
    props.activitiesTable.grantReadWriteData(this.syncWorker);
    props.rawBucket.grantReadWrite(this.syncWorker);
    props.eventBus.grantPutEventsTo(this.syncWorker);

    this.syncWorker.addEventSource(
      new SqsEventSource(this.activitySyncQueue, {
        batchSize: 5,
        maxBatchingWindow: cdk.Duration.seconds(5),
      })
    );

    // 5. Fetch Worker Lambda (SQS EventSource)
    const fetchLogGroup = new logs.LogGroup(this, 'FetchWorkerLogGroup', {
      logGroupName: `/aws/lambda/strava-hub-${env}-fetch-worker`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy,
    });

    this.fetchWorker = new NodejsFunction(this, 'FetchWorkerLambda', {
      functionName: `strava-hub-${env}-fetch-worker`,
      description: `Strava Hub Fetch Worker for historical activity backfill (${env})`,
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(__dirname, '../../src/workers/fetch-worker.js'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(300),
      memorySize: 512,
      logGroup: fetchLogGroup,
      environment: commonLambdaEnv,
      bundling: {
        minify: isProd,
        sourceMap: true,
      },
    });

    props.kmsKey.grantEncryptDecrypt(this.fetchWorker);
    props.athletesTable.grantReadWriteData(this.fetchWorker);
    props.activitiesTable.grantReadWriteData(this.fetchWorker);
    props.rawBucket.grantReadWrite(this.fetchWorker);
    props.eventBus.grantPutEventsTo(this.fetchWorker);
    this.activitySyncQueue.grantSendMessages(this.fetchWorker);

    this.fetchWorker.addEventSource(
      new SqsEventSource(this.activityFetchQueue, {
        batchSize: 1,
      })
    );

    // 6. HTTP API Gateway (API Gateway v2)
    this.httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: `strava-hub-${env}-api`,
      description: `Strava Hub HTTP API Gateway (${env})`,
      corsPreflight: {
        allowHeaders: ['Content-Type', 'Authorization'],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.PATCH,
          apigwv2.CorsHttpMethod.DELETE,
          apigwv2.CorsHttpMethod.OPTIONS,
        ],
        allowOrigins: ['*'],
      },
    });

    const lambdaIntegration = new HttpLambdaIntegration('LambdaIntegration', this.apiLambda);

    // Add Routes
    this.httpApi.addRoutes({
      path: '/webhook',
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: lambdaIntegration,
    });

    this.httpApi.addRoutes({
      path: '/auth/strava',
      methods: [apigwv2.HttpMethod.POST],
      integration: lambdaIntegration,
    });

    this.httpApi.addRoutes({
      path: '/user/status',
      methods: [apigwv2.HttpMethod.GET],
      integration: lambdaIntegration,
    });

    this.httpApi.addRoutes({
      path: '/user/sync',
      methods: [apigwv2.HttpMethod.POST],
      integration: lambdaIntegration,
    });

    this.httpApi.addRoutes({
      path: '/user',
      methods: [apigwv2.HttpMethod.DELETE],
      integration: lambdaIntegration,
    });

    this.httpApi.addRoutes({
      path: '/api/apps',
      methods: [apigwv2.HttpMethod.GET],
      integration: lambdaIntegration,
    });

    // 7. Configure Throttling
    const defaultStage = this.httpApi.defaultStage?.node.defaultChild as apigwv2.CfnStage;
    if (defaultStage) {
      defaultStage.defaultRouteSettings = {
        throttlingBurstLimit: 50,
        throttlingRateLimit: 25,
      };
      defaultStage.routeSettings = {
        'POST /webhook': {
          throttlingBurstLimit: 100,
          throttlingRateLimit: 50,
        },
        'GET /webhook': {
          throttlingBurstLimit: 10,
          throttlingRateLimit: 5,
        },
        'POST /auth/strava': {
          throttlingBurstLimit: 10,
          throttlingRateLimit: 5,
        },
      };
    }

    // 8. SSM Parameter Store: Contract Endpoints
    new ssm.StringParameter(this, 'SSMApiEndpoint', {
      parameterName: `/strava-hub/${env}/api-endpoint`,
      stringValue: this.httpApi.apiEndpoint,
      description: `Strava Hub API Endpoint (${env})`,
    });

    new ssm.StringParameter(this, 'SSMSyncQueueUrl', {
      parameterName: `/strava-hub/${env}/sync-queue-url`,
      stringValue: this.activitySyncQueue.queueUrl,
      description: `Strava Hub Activity Sync Queue URL (${env})`,
    });

    new ssm.StringParameter(this, 'SSMFetchQueueUrl', {
      parameterName: `/strava-hub/${env}/fetch-queue-url`,
      stringValue: this.activityFetchQueue.queueUrl,
      description: `Strava Hub Activity Fetch Queue URL (${env})`,
    });

    // 9. Stack Outputs
    new cdk.CfnOutput(this, 'ApiEndpointOutput', {
      value: this.httpApi.apiEndpoint,
      description: `HTTP API Endpoint (${env})`,
      exportName: `strava-hub-${env}-api-endpoint`,
    });

    new cdk.CfnOutput(this, 'SyncQueueUrlOutput', {
      value: this.activitySyncQueue.queueUrl,
      description: `Activity Sync Queue URL (${env})`,
      exportName: `strava-hub-${env}-sync-queue-url`,
    });

    new cdk.CfnOutput(this, 'FetchQueueUrlOutput', {
      value: this.activityFetchQueue.queueUrl,
      description: `Activity Fetch Queue URL (${env})`,
      exportName: `strava-hub-${env}-fetch-queue-url`,
    });
  }
}
