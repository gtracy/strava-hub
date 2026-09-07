import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as events from 'aws-cdk-lib/aws-events';
import * as ssm from 'aws-cdk-lib/aws-ssm';

export interface CoreDataStackProps extends cdk.StackProps {
  environment: 'dev' | 'prod';
}

export class CoreDataStack extends cdk.Stack {
  public readonly kmsKey: kms.Key;
  public readonly athletesTable: dynamodb.Table;
  public readonly activitiesTable: dynamodb.Table;
  public readonly rawBucket: s3.Bucket;
  public readonly eventBus: events.EventBus;

  constructor(scope: Construct, id: string, props: CoreDataStackProps) {
    super(scope, id, props);

    const env = props.environment;
    const isProd = env === 'prod';
    const removalPolicy = isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY;

    // Apply standard tags
    cdk.Tags.of(this).add('Project', 'strava-hub');
    cdk.Tags.of(this).add('Environment', env);
    cdk.Tags.of(this).add('ManagedBy', 'CDK');

    // 1. KMS Customer Managed Key for token and data encryption
    this.kmsKey = new kms.Key(this, 'TokenKey', {
      alias: `alias/strava-hub-${env}-key`,
      description: `KMS key for encrypting Strava athlete tokens and sensitive data (${env})`,
      enableKeyRotation: true,
      removalPolicy,
    });

    // 2. Multi-tenant Athletes Table
    // Partition key: athleteId (Strava Athlete ID)
    this.athletesTable = new dynamodb.Table(this, 'AthletesTable', {
      tableName: `strava-hub-${env}-athletes`,
      partitionKey: { name: 'athleteId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: this.kmsKey,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: isProd,
      },
      removalPolicy,
    });

    // 3. Multi-tenant Activities Table (Indexed Metadata)
    // Partition key: athleteId, Sort key: activityId
    this.activitiesTable = new dynamodb.Table(this, 'ActivitiesTable', {
      tableName: `strava-hub-${env}-activities`,
      partitionKey: { name: 'athleteId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'activityId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: this.kmsKey,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: isProd,
      },
      removalPolicy,
    });

    // Global Secondary Index: AthleteStartDateIndex for timeline queries
    this.activitiesTable.addGlobalSecondaryIndex({
      indexName: 'AthleteStartDateIndex',
      partitionKey: { name: 'athleteId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'startDate', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // 4. S3 Bucket for Raw Activity Payloads and Streams
    // Global uniqueness ensured via account and region suffix
    this.rawBucket = new s3.Bucket(this, 'RawActivityBucket', {
      bucketName: `strava-hub-${env}-raw-data-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}`,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.kmsKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      enforceSSL: true,
      autoDeleteObjects: !isProd,
      removalPolicy,
      lifecycleRules: [
        {
          id: 'NoncurrentVersionExpiration',
          noncurrentVersionExpiration: cdk.Duration.days(30),
          enabled: true,
        },
      ],
    });

    // 5. Custom Amazon EventBridge Event Bus for Platform Events
    this.eventBus = new events.EventBus(this, 'PlatformEventBus', {
      eventBusName: `strava-hub-${env}-bus`,
      description: `Custom EventBridge bus for Strava Hub platform activity events (${env})`,
    });

    // 6. SSM Parameter Store: Contract-Based Discovery for Mini-Apps
    const ssmParams: Record<string, string> = {
      [`/strava-hub/${env}/event-bus-name`]: this.eventBus.eventBusName,
      [`/strava-hub/${env}/event-bus-arn`]: this.eventBus.eventBusArn,
      [`/strava-hub/${env}/activities-table-name`]: this.activitiesTable.tableName,
      [`/strava-hub/${env}/activities-table-arn`]: this.activitiesTable.tableArn,
      [`/strava-hub/${env}/athletes-table-name`]: this.athletesTable.tableName,
      [`/strava-hub/${env}/athletes-table-arn`]: this.athletesTable.tableArn,
      [`/strava-hub/${env}/raw-bucket-name`]: this.rawBucket.bucketName,
      [`/strava-hub/${env}/raw-bucket-arn`]: this.rawBucket.bucketArn,
      [`/strava-hub/${env}/kms-key-id`]: this.kmsKey.keyId,
      [`/strava-hub/${env}/kms-key-arn`]: this.kmsKey.keyArn,
    };

    let paramIndex = 0;
    for (const [parameterName, stringValue] of Object.entries(ssmParams)) {
      new ssm.StringParameter(this, `SSMParam${paramIndex++}`, {
        parameterName,
        stringValue,
        description: `Strava Hub ${env} resource configuration`,
      });
    }

    // 7. Stack Outputs
    new cdk.CfnOutput(this, 'KmsKeyArnOutput', {
      value: this.kmsKey.keyArn,
      description: `KMS Key ARN (${env})`,
      exportName: `strava-hub-${env}-kms-key-arn`,
    });

    new cdk.CfnOutput(this, 'AthletesTableNameOutput', {
      value: this.athletesTable.tableName,
      description: `Athletes DynamoDB Table Name (${env})`,
      exportName: `strava-hub-${env}-athletes-table-name`,
    });

    new cdk.CfnOutput(this, 'ActivitiesTableNameOutput', {
      value: this.activitiesTable.tableName,
      description: `Activities DynamoDB Table Name (${env})`,
      exportName: `strava-hub-${env}-activities-table-name`,
    });

    new cdk.CfnOutput(this, 'RawBucketNameOutput', {
      value: this.rawBucket.bucketName,
      description: `Raw Data S3 Bucket Name (${env})`,
      exportName: `strava-hub-${env}-raw-bucket-name`,
    });

    new cdk.CfnOutput(this, 'EventBusArnOutput', {
      value: this.eventBus.eventBusArn,
      description: `Custom EventBridge Bus ARN (${env})`,
      exportName: `strava-hub-${env}-event-bus-arn`,
    });
  }
}
