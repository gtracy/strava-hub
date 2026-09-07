#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { CoreDataStack } from '../lib/core-data-stack';

const app = new cdk.App();

// Read target environment from context if specified (e.g. -c env=prod), or synthesize both
const targetEnv = app.node.tryGetContext('env');

const envConfig = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION || 'us-east-2',
};

if (!targetEnv || targetEnv === 'dev') {
  new CoreDataStack(app, 'StravaHubCore-dev', {
    environment: 'dev',
    env: envConfig,
    description: 'Strava Hub Core Data Stack (Development Environment)',
  });
}

if (!targetEnv || targetEnv === 'prod') {
  new CoreDataStack(app, 'StravaHubCore-prod', {
    environment: 'prod',
    env: envConfig,
    description: 'Strava Hub Core Data Stack (Production Environment)',
  });
}

app.synth();
