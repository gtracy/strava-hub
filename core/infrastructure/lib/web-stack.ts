import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as path from 'path';
import * as fs from 'fs';

export interface WebStackProps extends cdk.StackProps {
  environment: 'dev' | 'prod';
}

export class WebStack extends cdk.Stack {
  public readonly frontendBucket: s3.Bucket;
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: WebStackProps) {
    super(scope, id, props);

    const env = props.environment;
    const isProd = env === 'prod';
    const removalPolicy = isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY;

    cdk.Tags.of(this).add('Project', 'strava-hub');
    cdk.Tags.of(this).add('Environment', env);
    cdk.Tags.of(this).add('ManagedBy', 'CDK');

    // 1. Private S3 Bucket for Frontend SPA Assets
    this.frontendBucket = new s3.Bucket(this, 'FrontendBucket', {
      bucketName: `strava-hub-${env}-frontend-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      autoDeleteObjects: !isProd,
      removalPolicy,
    });

    // 2. CloudFront Distribution (Origin Access Control)
    this.distribution = new cloudfront.Distribution(this, 'FrontendDistribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.frontendBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      defaultRootObject: 'index.html',
      errorResponses: [
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
      ],
    });

    // 3. S3 Bucket Deployment: Sync frontend/dist to S3 and invalidate CloudFront
    const distPath = path.join(__dirname, '../../frontend/dist');
    if (!fs.existsSync(distPath)) {
      fs.mkdirSync(distPath, { recursive: true });
      fs.writeFileSync(path.join(distPath, 'index.html'), '<!doctype html><html><body><h1>Strava Hub</h1><p>Building frontend assets...</p></body></html>');
    }

    new s3deploy.BucketDeployment(this, 'DeployFrontend', {
      sources: [s3deploy.Source.asset(distPath)],
      destinationBucket: this.frontendBucket,
      distribution: this.distribution,
      distributionPaths: ['/*'],
      prune: false,
    });

    // 4. SSM Parameter Store
    new ssm.StringParameter(this, 'SSMFrontendUrl', {
      parameterName: `/strava-hub/${env}/frontend-url`,
      stringValue: `https://${this.distribution.distributionDomainName}`,
      description: `Strava Hub Frontend URL (${env})`,
    });

    // 5. Outputs
    new cdk.CfnOutput(this, 'FrontendUrlOutput', {
      value: `https://${this.distribution.distributionDomainName}`,
      description: `Strava Hub Web URL (${env})`,
      exportName: `strava-hub-${env}-frontend-url`,
    });
  }
}
